# Terreng3D

**Bruk programmet her: https://markusbfunk.github.io/terreng3d/**

Nettleserprogram som lager fargelagte 3D-modeller av terreng hvor som helst i verden, klare for
FDM-printing med flere filamenter (laget for Bambu Lab H2D med AMS). Det trengs ingen installasjon: alt
kjører i nettleseren, og siden kan legges ut på GitHub Pages.

## Kjøre lokalt

```bash
node serve.cjs
```

Åpne deretter http://localhost:8137. ES-moduler krever http, så `file://` fungerer ikke.

Det valgte området lagres i nettadressen (`#bbox=sør,vest,nord,øst`), slik at en lenke åpner samme område.

## Slik fungerer det

1. **Område:** Velg et rektangel i kartet. Det deles automatisk i fliser som ikke er større enn
   «Maks flisstørrelse» (300 mm passer H2D).
2. **Høydedata:**
   - *Automatisk* (standard): Kartverkets nasjonale høydemodell DTM 1 m i Norge, hentet via WCS.
     Områder uten Kartverket-data (hav, utlandet) fylles fra AWS Terrain Tiles.
   - *AWS Terrain Tiles*: global dekning med cirka 10–30 m oppløsning.
3. **Farger** (velg én kilde):
   - *Kartverket topo* (kun Norge) eller *OpenTopoMap* (global): fargene i kartet reduseres med k-means
     (CIELAB) til N filamentfarger.
   - *Sentinel-2* (satellitt, 10 m): fargene reduseres på samme måte. Lisensen er CC BY-NC-SA, altså kun
     for ikke-kommersiell bruk.
   - *OpenStreetMap-arealtyper* via Overpass: rene klasser som vann, skog, isbre, fjell og bebyggelse.
4. **Symboler** (fra OpenStreetMap): kjegleformede trær i skogområder og hus med saltak der det er
   bygninger. De blir egne deler med eget filament. Små bygninger forstørres til en minstestørrelse som
   kan printes, og tynnes ut der det er tett.
5. **Mesh:** Hver flis blir en lukket (vanntett) modell. Alle flisene bruker samme høydeskala og samme
   bunnivå, slik at de passer sammen.
6. **3MF-eksport:**
   - *Bambu Studio-prosjekt (H2D 0.4)*: filamenter i kartfargene, malte flater og én byggeplate per flis.
     Åpnes med Fil → Åpne prosjekt.
   - *Generisk 3MF*: `paint_color` / `slic3rpe:mmu_segmentation` for PrusaSlicer, OrcaSlicer og
     andre slicere.

## Filer

| Fil | Innhold |
|---|---|
| `js/sources.js` | Kartkilder |
| `js/elevation.js` | Høydedata (Kartverket WCS og global reserve) |
| `js/tiff.js` | Minimal GeoTIFF-leser |
| `js/tiles.js` | Henting av kartfliser og bilineær sampling |
| `js/colors.js` | k-means, støyfjerning og palett |
| `js/osm.js` | Overpass-spørring og rasterisering av arealtyper |
| `js/symbols.js` | Plassering og mesh for trær og bygninger |
| `js/mesh.js` | Vanntett flis-mesh |
| `js/export3mf.js` | 3MF-skriver (Bambu-prosjekt og generisk) |
| `js/bambu_h2d_settings.json` | H2D-prosjektinnstillinger (fra Bambu Studios systemprofiler) |
| `js/preview.js` | 3D-forhåndsvisning (three.js) |
| `js/main.js` | Grensesnitt og arbeidsflyt |

## Kilder og lisenser

- Høydedata: © Kartverket (CC BY 4.0) · AWS Terrain Tiles / Mapzen
- Kart: © Kartverket · © OpenTopoMap (CC BY-SA) · © OpenStreetMap-bidragsytere (ODbL)
- Satellitt: Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)
- `bambu_h2d_settings.json` er utledet av Bambu Studios systemprofiler (AGPL-3.0).

## Videre ideer

- Høyoppløselige nasjonale høydemodeller for andre land (swissALTI3D, USGS 3DEP, Lantmäteriet).
- ESA WorldCover 10 m som global arealklassekilde uten Overpass.
- Styrepinner mellom fliser og flate innsjøer.
- Hul sokkel for mindre filamentforbruk på store fliser.
