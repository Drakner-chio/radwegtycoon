"""Radweg Tycoon – Kartenpipeline: OpenStreetMap -> Spielkacheln."""

__version__ = "0.1.0"

# Version des Spielmodells (Klassen, Querschnitte, Zustandsschätzung).
# Erhöhen, wenn sich die Bedeutung von Feldern in den Kacheln ändert.
MODEL_VERSION = 2

# Version des Kachelformats (Aufbau der JSON-Dateien).
FORMAT_VERSION = 1

CRS = "EPSG:25832"  # ETRS89 / UTM Zone 32N – amtliches System in NRW, Meter
