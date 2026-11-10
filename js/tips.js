// Forklarende tooltips: hold musa over en innstilling i et halvt sekund.

const TIPS = {
  searchInput: 'Søk etter et stedsnavn. Kartet flytter seg dit, og utsnittet legges midt i kartet.',
  drawBtn: 'Klikk og dra i kartet for å tegne et nytt utsnitt. Rotasjonen nullstilles.',
  viewBtn: 'Gjør det du ser i kartet akkurat nå til utsnittet. Rotasjonen nullstilles.',
  shape: 'Formen på modellen sett ovenfra. Rektangel kan ha fritt forhold mellom bredde og høyde; de andre formene er regulære og låser forholdet.',
  rotLabel: 'Roterer utsnittet rundt midtpunktet (grader med klokka). Modellen blir liggende rett på byggeplata, så kartet i modellen blir rotert i forhold til nord.',
  elevSrc: 'Hvor høydedataene kommer fra. «Automatisk» bruker Kartverkets 1 m-modell i Norge og en global, grovere modell (ca. 10–30 m) ellers.',
  widthMm: 'Hvor bred hele modellen blir i millimeter. Målestokken (og dermed hvor høye fjellene blir) følger av denne.',
  maxTile: 'Største bredde/høyde på én del. Er modellen større, deles den i flere fliser som printes hver for seg og settes sammen. 300 mm passer H2D.',
  res: 'Avstand mellom høydepunktene i modellen. Mindre tall gir finere detaljer, men større filer og tregere generering. 0,4 mm tilsvarer dysebredden.',
  exag: 'Hvor mye høydene forsterkes. 1 gir riktig forhold; 1,5–2 får terrenget til å se mer dramatisk ut, særlig på store, flate områder.',
  base: 'Tykkelsen på den flate bunnen under det laveste punktet i modellen. Tekst i undersiden krever minst ca. 1 mm.',
  seaStep: 'Land løftes så mye over havflaten, slik at kystlinjen blir en tydelig kant. Brukes bare når «Flatt hav» er på.',
  flatSea: 'Alt under 0 moh. (hav og fjorder) blir helt flatt i stedet for å vise havbunnen.',
  colorSrc: 'Hvor fargene på toppen av modellen kommer fra. Kartverkets kart uten tekst gir rene flater i Norge; utenfor Norge brukes OpenTopoMap automatisk.',
  osmClasses: 'Hvilke arealtyper fra OpenStreetMap som får egen farge. Alt annet får grunnfargen.',
  seaWater: 'Områder på eller under 0 moh. farges som vann selv om OpenStreetMap ikke har et vannområde der.',
  nColors: 'Hvor mange farger kartet reduseres til. Hver farge blir ett filament (AMS-spor). Veiene teller med hvis de er på. Trær og bygninger deler plass med en av fargene. Færre farger gir enklere print med mindre bytting.',
  roadOpt: 'Legger veiene på som én egen mørkegrå farge (eget filament). Slå av for å la veiene få fargen til området rundt.',
  smooth: 'Fjerner enkeltpiksler og fransete kanter mellom fargene. Flere passeringer gir rolige flater, men små detaljer kan forsvinne.',
  symTrees: 'Setter små kjegleformede trær i skogområder (fra OpenStreetMap). De blir en egen del som deler filament med den grønneste kartfargen; du kan velge en annen plass under Filamenter.',
  treeSpacing: 'Minste avstand mellom trærne i millimeter (aldri mindre enn diameteren).',
  treeHeight: 'Hvor høye trærne blir i modellen.',
  treeDiam: 'Hvor brede trærne er nederst. Under ca. 1,2 mm blir de vanskelige å printe.',
  treeFill: 'Hvor stor andel av skogen som får trær (0–1). Lavere tall gir mer spredt skog.',
  symBuildings: 'Lager hus med saltak der OpenStreetMap har bygninger. De blir en egen del som deler filament med veifargen (eller den mørkeste fargen); kan endres under Filamenter.',
  bldMin: 'Bygninger som er mindre enn dette i modellen, forstørres slik at de kan printes. Tette områder tynnes ut.',
  bldMinH: 'Laveste hushøyde i modellen, slik at husene synes.',
  showTreesLbl: 'Vis eller skjul trærne i modellen. Gjelder både forhåndsvisningen og eksporten.',
  showBldLbl: 'Vis eller skjul bygningene i modellen. Gjelder både forhåndsvisningen og eksporten.',
  genBtn: 'Henter data og bygger modellen. Store områder kan ta litt tid.',
  format: 'Bambu Studio-prosjekt har filamenter og byggeplater klare for H2D. Generisk 3MF passer PrusaSlicer, OrcaSlicer og andre.',
  labelOn: 'Graverer stedsnavn og koordinatene til midtpunktet 0,6 mm inn i bunnen. Teksten speilvendes, så den leses riktig når modellen snus. Ved flere fliser får hver flis også navnet sitt.',
  labelName: 'Navnet som graveres. Fylles automatisk med nærmeste by eller tettsted, eller kommunen hvis området ikke ligger i et. Du kan skrive inn et eget.',
};

const tip = document.createElement('div');
tip.className = 'tip';
document.body.append(tip);
let timer = null, current = null;

function show(el) {
  tip.textContent = el.dataset.tip;
  tip.classList.add('show');
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  let x = r.right + 10, y = r.top;
  if (x + t.width > innerWidth - 8) { x = Math.max(8, r.left); y = r.bottom + 6; }
  y = Math.min(y, innerHeight - t.height - 8);
  tip.style.left = x + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}
function hide() {
  clearTimeout(timer);
  current = null;
  tip.classList.remove('show');
}

for (const [id, text] of Object.entries(TIPS)) {
  const el = document.getElementById(id);
  if (!el) continue;
  const target = el.tagName === 'LABEL' || el.tagName === 'BUTTON' || el.tagName === 'DIV' ? el : el.closest('label') || el;
  target.dataset.tip = text;
  target.removeAttribute('title');
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (el === current) return;
  hide();
  if (!el) return;
  current = el;
  timer = setTimeout(() => show(el), 500);
});
document.addEventListener('mousedown', hide);
document.addEventListener('scroll', hide, true);
