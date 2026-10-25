# Radweg Tycoon – Kartenviewer
# Statische Seite + Kacheln. Die Kacheln kommen per Volume nach /usr/share/nginx/html/daten,
# z. B. -v /mnt/user/appdata/radwegtycoon:/usr/share/nginx/html/daten:ro
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
EXPOSE 80
