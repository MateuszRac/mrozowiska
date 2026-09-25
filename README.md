# Mrozowiska w Polsce – mapa interaktywna

**Mapa:** https://mateuszrac.github.io/mrozowiska/

Interaktywna mapa zastoisk zimnego powietrza (mrozowisk) w Polsce. Pokazuje, gdzie w pogodne
noce powstają najsilniejsze ujemne anomalie temperatury powierzchni względem otoczenia. Dane
pochodzą z numerycznego modelu terenu, nocnych obserwacji satelitarnych VIIRS i modelu U-Net.

## Warstwy

- **Topografia:** wysokość n.p.m. z cieniowaniem rzeźby.
- **Parametry NMT (100 m):** Topographic Position Index (r = 2 km), głębokość zagłębień
  bezodpływowych, Topographic Wetness Index.
- **Model:** przewidywana nocna anomalia temperatury powierzchni względem otoczenia (σ = 10 km)
  i klasy mrozowisk. U-Net, siatka 1 km.
- **Obserwacje:** średnia anomalia z 2222 nocy VIIRS 2023–2026 (00–05 UTC).
- **Porównanie:** różnica obserwacje VIIRS − model.
- **Granice:** województwa, powiaty, gminy.
- **Regiony fizycznogeograficzne:** megaregiony, prowincje, podprowincje, makroregiony i
  mezoregiony. Nazwy regionów na mapie można włączyć lub wyłączyć.

Skala barwna może być stała, dynamiczna (z widocznego fragmentu mapy) albo ręczna. Kliknięcie w
mapę lub stację pokazuje położenie (województwo, powiat, gmina, megaregion, prowincja,
podprowincja, makroregion, mezoregion) i wartości wszystkich warstw w danym punkcie. Stacje
IMGW-PIB można filtrować według kategorii; można też wczytać własny plik CSV (kolumny `nazwa,
lon, lat, kategoria`).

## Źródła danych

- Numeryczny model terenu (NMT, 100 m) i granice administracyjne (PRG): © GUGiK, geoportal.gov.pl
- Regiony fizycznogeograficzne: Solon J., Borzyszkowski J. i in., 2018. Physico-geographical
  mesoregions of Poland – verification and adjustment of boundaries on the basis of contemporary
  spatial data. *Geographia Polonica* 91(2)
- Temperatura powierzchni: VIIRS VNP21A1N / VJ121A1N / VJ221A1N, NASA LP DAAC
- Lokalizacje stacji: IMGW-PIB
- Mapa tła: © współtwórcy OpenStreetMap
- Biblioteki: Leaflet, PapaParse

Model ma charakter eksperymentalny. Nie uwzględnia pokrycia terenu, zbiorników wodnych ani
miejskiej wyspy ciepła.
