"""OSM-XML -> kompaktes JSON für die Radweg-Tycoon-Kartenvorschau (Meter, y nach unten)."""
import sys, json, math, xml.etree.ElementTree as ET
src, dst = sys.argv[1], sys.argv[2]
r = ET.parse(src).getroot()
b = r.find('bounds').attrib
minlat, minlon, maxlat, maxlon = (float(b[k]) for k in ('minlat','minlon','maxlat','maxlon'))
lat0 = (minlat+maxlat)/2
kx = 111320*math.cos(math.radians(lat0)); ky = 110540
def proj(lat, lon): return ((lon-minlon)*kx, (maxlat-lat)*ky)
Wm, Hm = proj(minlat, maxlon)
tags = lambda e: {x.get('k'): x.get('v') for x in e.findall('tag')}
nodes = {}; ntags = {}
for n in r.findall('node'):
    nodes[n.get('id')] = proj(float(n.get('lat')), float(n.get('lon')))
    t = tags(n)
    if t: ntags[n.get('id')] = t
ways = {}
for w in r.findall('way'):
    ways[w.get('id')] = ([nd.get('ref') for nd in w.findall('nd')], tags(w))

used = {}; NL = []
def nidx(nid):
    if nid not in used:
        used[nid] = len(NL); x, y = nodes[nid]; NL.append([round(x, 1), round(y, 1)])
    return used[nid]
def coords(refs): return [c for nid in refs if nid in nodes for c in (round(nodes[nid][0], 1), round(nodes[nid][1], 1))]

ROAD = {'secondary','tertiary','unclassified','residential','living_street','service','track','path','footway','cycleway','bridleway','steps','pedestrian','primary','trunk','secondary_link','tertiary_link'}
KEEP = ['name','surface','smoothness','maxspeed','maxspeed:conditional','cycleway','cycleway:both','cycleway:left','cycleway:right','cycleway:both:surface','cycleway:right:surface','cycleway:left:surface',
        'cycleway:both:smoothness','sidewalk','sidewalk:both','sidewalk:left','sidewalk:right','oneway','oneway:bicycle','bicycle','foot','motor_vehicle','access','lanes','junction','service','tracktype',
        'bicycle_road','width','lit','segregated','ref','bridge','layer','tunnel','mtb:scale','surface:note']
roads = []
for wid, (refs, t) in ways.items():
    h = t.get('highway')
    if h not in ROAD or t.get('area') == 'yes': continue
    refs = [n for n in refs if n in nodes]
    if len(refs) < 2: continue
    roads.append({'i': int(wid), 'h': h, 't': {k: t[k] for k in KEEP if k in t}, 'n': [nidx(n) for n in refs]})

# Knoten-Merkmale (nur für Straßenknoten)
NF = {}
for nid, i in used.items():
    t = ntags.get(nid)
    if not t: continue
    f = t.get('highway') or t.get('barrier')
    if f in ('traffic_signals','crossing','give_way','stop','mini_roundabout','turning_circle','bus_stop','bollard','cycle_barrier','gate','lift_gate'):
        NF[i] = f

# Flächen
def area_kind(t):
    if 'building' in t: return 'b:' + t['building']
    for k in ('amenity','leisure','landuse','natural'):
        v = t.get(k)
        if not v: continue
        if k == 'amenity' and v not in ('parking','school','kindergarten','place_of_worship','grave_yard'): continue
        if k == 'natural' and v not in ('wood','heath','scrub','water','wetland','sand','grassland','bare_rock'): continue
        return k[0] + ':' + v
    if t.get('waterway') == 'riverbank': return 'n:water'
    return None
areas = []
def ring_ok(refs): return len(refs) >= 4 and refs[0] == refs[-1]
for wid, (refs, t) in ways.items():
    k = area_kind(t)
    if not k or not ring_ok(refs): continue
    if 'highway' in t and 'building' not in t and t.get('area') != 'yes': continue
    c = coords(refs)
    if len(c) >= 6: areas.append({'k': k, 'i': int(wid), 'p': [c], 'nm': t.get('name')})
def join_rings(segs):
    segs = [s[:] for s in segs if len(s) >= 2]; rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]: cur += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == cur[-1]: cur += s[::-1][1:]; segs.pop(i); changed = True; break
                if s[-1] == cur[0]: cur = s[:-1] + cur; segs.pop(i); changed = True; break
                if s[0] == cur[0]: cur = s[::-1][:-1] + cur; segs.pop(i); changed = True; break
        if cur[0] == cur[-1] and len(cur) >= 4: rings.append(cur)
    return rings
bike_routes = []
for rl in r.findall('relation'):
    t = tags(rl)
    if t.get('type') == 'multipolygon':
        k = area_kind(t)
        if not k: continue
        outer = [ways[m.get('ref')][0] for m in rl.findall('member') if m.get('type') == 'way' and m.get('role') in ('outer', '') and m.get('ref') in ways]
        inner = [ways[m.get('ref')][0] for m in rl.findall('member') if m.get('type') == 'way' and m.get('role') == 'inner' and m.get('ref') in ways]
        rings = [coords(x) for x in join_rings(outer)]
        holes = [coords(x) for x in join_rings(inner)]
        for ring in rings:
            if len(ring) >= 6: areas.append({'k': k, 'i': int(rl.get('id')), 'p': [ring] + holes, 'nm': t.get('name')})
    elif t.get('route') == 'bicycle':
        mem = [int(m.get('ref')) for m in rl.findall('member') if m.get('type') == 'way']
        bike_routes.append({'n': t.get('name') or t.get('ref') or 'Radroute', 'net': t.get('network'), 'w': mem})

# Wasserläufe, Bahnstrecken
lines = []
for wid, (refs, t) in ways.items():
    if t.get('waterway') in ('stream','river','ditch','canal'):
        lines.append({'k': 'w:' + t['waterway'], 'c': coords(refs), 'nm': t.get('name')})
    elif t.get('railway') in ('rail','abandoned','disused'):
        lines.append({'k': 'r:' + t['railway'], 'c': coords(refs)})
    elif t.get('barrier') in ('hedge','fence','wall') or t.get('natural') == 'tree_row':
        lines.append({'k': 'x:' + (t.get('barrier') or 'tree_row'), 'c': coords(refs)})

# POIs
pois = []
def poi_kind(t):
    for k in ('amenity','shop','leisure','tourism'):
        if k in t: return k + ':' + t[k]
    if t.get('natural') == 'tree': return 'natural:tree'
    return None
skip = {'amenity:bench','amenity:waste_basket','amenity:parking','amenity:post_box','tourism:information','amenity:bbq','amenity:shelter'}
for nid, t in ntags.items():
    k = poi_kind(t)
    if k and k not in skip and nid in nodes:
        x, y = nodes[nid]
        if 0 <= x <= Wm and 0 <= y <= Hm: pois.append({'k': k, 'x': round(x, 1), 'y': round(y, 1), 'nm': t.get('name')})
for wid, (refs, t) in ways.items():
    k = poi_kind(t)
    if k and k not in skip and 'name' in t and refs:
        xs = [nodes[n] for n in refs if n in nodes]
        if xs: pois.append({'k': k, 'x': round(sum(p[0] for p in xs)/len(xs), 1), 'y': round(sum(p[1] for p in xs)/len(xs), 1), 'nm': t.get('name')})

place = next((tags(n).get('name') for n in r.findall('node') if tags(n).get('place') in ('village','town','city')), 'Ort')
out = {'place': place, 'W': round(Wm, 1), 'H': round(Hm, 1), 'bounds': [minlat, minlon, maxlat, maxlon],
       'N': NL, 'NF': NF, 'roads': roads, 'areas': areas, 'lines': lines, 'pois': pois, 'routes': bike_routes}
json.dump(out, open(dst, 'w'), separators=(',', ':'), ensure_ascii=False)
print(place, 'W', round(Wm), 'H', round(Hm), 'nodes', len(NL), 'roads', len(roads), 'areas', len(areas), 'lines', len(lines), 'pois', len(pois), 'routes', len(bike_routes))
