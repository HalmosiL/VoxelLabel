# Usage-elemzési módszertan

Ez a dokumentum azt írja le, hogyan jutunk a VoxelLabel Usage oldalának adataiból
döntésig: mit mérünk pontosan, milyen rendszerességgel nézzük, hogyan
fogalmazunk hipotézist, és mikor mondhatjuk, hogy egy változtatás tényleg
segített. A mérőszámok nevei angolul szerepelnek, ahogy a felületen látszanak.

A mérés három célt szolgál. Minden elemzésnek legalább az egyikhez kell kötődnie:

1. **Rövidebb annotációs ciklusidő.** Egy eset a sorba kerüléstől a jóváhagyásig.
2. **Könnyebb, intuitívabb eszköz.** Kevesebb elakadás, kevesebb fölösleges lépés,
   kisebb kognitív terhelés.
3. **Rövidebb betanulás.** Egy új ember minél hamarabb érje el a saját stabil tempóját.

---

## 1. Mit mérünk: definíciók

Minden szám mediánnal dolgozik, átlaggal nem, mert egy-egy elhúzódó eset nem torzíthatja.
Admin- és tesztfiókot a rendszer rögzít, de egyik számba sem számít bele
(Settings → Who counts). A fejléc alatti sor mindig megmondja, hány emberből,
munkamenetből és eseményből készült az adott nézet.

| Mérőszám | Mit jelent pontosan | Jó irány | Buktató |
|---|---|---|---|
| **Hands-on time per case** | A viewerben egy eseten ténylegesen töltött idő, az összes ülésen összeadva. A 30 mp-nél hosszabb input nélküli szakaszok kimaradnak. | ↓ | Függ az eset nehézségétől. Ezért a **per object** változatot is nézd. |
| **Hands-on per object** | A kézi idő osztva a rajzolt objektumok számával | ↓ | Csak akkor van értéke, ha az esetnek van mentett objektuma. |
| **Sittings** | Hány külön ülésben készült el egy eset | ↓ | Az 1-nél több ülés megszakítást jelez. Ez lehet a munkarend is, nem csak az eszköz. |
| **Wait before the first action** | Az eset megnyitásától az első kattintásig vagy billentyűig eltelt idő | ↓ | Két dolog van benne: a kép betöltése és a tájékozódás. A kettőt a „Requests people wait on” választja szét. |
| **Cycle time: waiting / working** | Naptári idő. A várakozás a sorba kerüléstől az első megnyitásig tart, a munka a megnyitástól a beküldésig vagy döntésig. | ↓ | Az éjszakák és hétvégék is benne vannak. Emberek összehasonlítására nem alkalmas. |
| **Passed review first time** | Az esetek hány %-át hagyta jóvá a reviewer elsőre | ↑ | Kis esetszámnál ingadozik. |
| **Why objects are sent back** | Az elutasítás oka, amit a reviewer egy koppintással címkéz | – | Csak a címkézett elutasításokat látja. |
| **Felt difficulty (1–5)** | Minden n-edik befejezett eset után egy választható kérdés: mennyire volt megterhelő | ↓ | Szubjektív. Trendként és esetek összehasonlítására használd. |
| **Friction score (0–100)** | Képernyőnként négy jelből számolt pontszám: bounce, back & forth, no response, rage | ↓ | Arra jó, hogy megtaláld a rossz képernyőt. Ítélethez a replay is kell. |
| **Bounce** | Valaki 3 mp-en belül továbbment egy másik képernyőre | ↓ | Gyakorlott, gyors navigálásnál is magas lehet. |
| **Back & forth** | Rögtön visszament az előző képernyőre (A → B → A) | ↓ | Arra utal, hogy valamit fejben kell vinnie, amit a felületnek kellene mutatnia. |
| **No response** | Kattintható kinézetű elemre kattintott, és 1 mp-en belül semmi nem változott az oldalon | ↓ | A vászonra (rajzolás) és az üres háttérre eső kattintás nem számít. |
| **Rage burst** | Legalább 3 gyors kattintás egy pontra, és egyik sem kapott választ | ↓ | |
| **Tool time / switches** | Mennyi ideig van kiválasztva egy eszköz, és hányszor vált eszközt valaki egy eseten | – | A sok váltás arra utal, hogy egy feladat eszközei szét vannak szórva. |
| **Requests people wait on** | Az API-hívások ideje, ahogy a böngésző mérte, végpontonként | ↓ | A böngésző a hívás teljes idejét méri, a hálózattal együtt. |
| **Tutorials** | Hányszor nyitották meg, fejezték be vagy hagyták abba, és melyik lépésnél | ↑ befejezés | |
| **Learning curve** | Egy ember saját heti mediánja az első esete óta eltelt hetek szerint | ↓ majd stabil | Soha ne hasonlíts vele embert emberhez. |

**Amit a rendszer előre kiszűr.** Az 1 mp-nél rövidebb oldallátogatás (átirányítás, gyors
menükattintás) és a tutorialon belüli kattintás nem számít. A megállapítás-panel
trendet csak akkor jelez, ha mindkét időszakban legalább 5 eset van.

---

## 2. A ciklusidő felbontása: melyik kart húzzuk?

Mielőtt bármit javítunk, döntsük el, melyik részből áll a ciklusidő. A Cycle
time kártya és a hands-on csempék együtt mutatják meg.

```
ciklusidő = várakozás annotátorra + annotálás + várakozás reviewerre + review
            + (visszaküldés esetén az egész még egyszer)
```

| Ha ez dominál… | …akkor a gond | …és ezzel érdemes kezdeni |
|---|---|---|
| **Várakozás** (annotátorra vagy reviewerre) | Kiosztás, értesítés, kapacitás | Bottlenecks, Who's carrying the load, értesítések |
| **Hands-on idő** | Eszköz-ergonómia | Tool time, Friction, Wait before first action, replay |
| **Wait before the first action** | Betöltés vagy tájékozódás | Requests people wait on. Ha a kérés gyors, akkor a felület az oka. |
| **Visszaküldés** (alacsony első körös elfogadás) | Útmutató, címkedefiníció vagy eszközpontosság | Why objects are sent back. Egy domináns ok útmutató- vagy eszközhibát jelez, nem emberit. |

---

## 3. Elemzési rutin

### Hetente (kb. 20 perc)

1. **Overview → What stands out.** Kritikus tétel (elakadt eset) → azonnal intézkedni.
2. **Minden „Look into” tételnél** nyisd meg a mögötte lévő fület, és keress **3–5 konkrét
   munkamenetet** a People fülön. Nézd meg a replay-t. A szám megmutatja, hol keress,
   a replay megmutatja, miért.
3. **Amit látsz, írd be a hipotézis-naplóba** (lásd 6. pont). Ne javíts rögtön, előbb
   fogalmazd meg, mit vársz a javítástól.

### Havonta (kb. 1 óra)

1. **Release by release.** Az előző hónap kiadásai javítottak vagy rontottak?
2. **Cases → What makes a case expensive.** Mi mozog a legerősebben a kézi idővel?
   Az a legjobb célpont.
3. **Tutorials és learning curve.** Hol hagyják abba a tutorialt? Hány hét alatt
   áll be az új emberek tempója?
4. **Export → Copy summary.** A havi összefoglalót Jirába vagy e-mailbe másold, a
   nyers adatot (events.csv, bundle.json) archiváld.

---

## 4. Előtte–utána protokoll: segített-e a változtatás?

Minden kiadás automatikusan verziójelet kap (`app_version`), a Release by release
kártya buildenként mutatja ugyanazokat a számokat. Szabályok:

1. **Előre rögzítsd,** melyik mérőszámnak és merre kell mozdulnia, és mennyivel
   (pl. „hands-on per object −15%”). Ha csak utólag keresed, mindig találsz valamit.
2. **Elég adat mindkét oldalon.** Legalább 5 eset buildenként, hogy a felület egyáltalán
   megmutassa, de döntéshez 20+ eset kell. Kevesebbnél a különbség valószínűleg zaj.
3. **Ugyanazok az emberek.** Ha az új build alatt új kolléga kezdett, a számai a betanulás
   miatt rosszabbak lesznek. Hasonlítsd a tapasztalt emberek számait egymáshoz, vagy
   mindenkit csak a saját korábbi tempójához.
4. **Hasonló esetek.** Nézd meg a Cases fülön, hogy a két időszak esetei hasonlóak-e
   (objektum- és szeletszám). A **per object** szám ezt részben kiegyenlíti.
5. **Elég idő.** Egy új funkciót az első héten tanulni kell, ezért a második héttől mérj.
6. **Egyszerre egy változtatás.** Ha egy buildben három dolog változott, nem tudod
   szétválasztani, melyik hatott.
7. **Ellenőrizd a mellékhatást.** Ha a kézi idő csökkent, de az első körös elfogadás is
   romlott, akkor nem gyorsabb lett a munka, csak gyengébb.

---

## 5. Statisztikai játékszabályok

- **Medián, nem átlag.** Egy elhúzódó eset nem torzíthatja az egész heti képet.
- **Kis minta = jelzés, nem trend.** A csempék „few cases – a hint only” jelzést adnak
  5 eset alatt. Ilyenkor ne dönts.
- **Korreláció (r)** a Cases fülön: 0 = nincs összefüggés, 1 = együtt mozog. A 0,6
  feletti erős, a 0,3–0,6 közepes. **Az r nem ok-okozat.** Csak azt mondja meg, hol érdemes
  keresni.
- **Visszatérés az átlaghoz.** Egy kiugróan rossz hét után a következő szinte mindig jobb,
  változtatás nélkül is. Ne tulajdonítsd a javulást automatikusan a legutóbbi
  változtatásnak.
- **Senkit ne rangsorolj.** A számok az eszközről és a folyamatról szólnak. Ha embereket
  hasonlítunk, a viselkedés a számhoz igazodik (Goodhart-törvény), és a mérés
  értelmét veszti. A tanulási görbe mindenkit csak önmagához mér.
- **Adatminőség először.** Mielőtt következtetsz, nézd meg a fejléc alatti sort. Hány
  esemény és ember van benne? Ki van kizárva? Mennyi az „unknown” build (verziójel
  előtti adat)?

---

## 6. Hipotézis-napló (sablon)

Minden megfigyelés egy sor. A napló a legfontosabb kimenet: ebből lesz a fejlesztési
ütemterv.

| Dátum | Megfigyelés (szám + replay) | Hipotézis | Változtatás | Várt hatás (mérőszám, irány, mérték) | Build | Eredmény (2+ hét után) |
|---|---|---|---|---|---|---|
| 2026-09-23 | A /my-jobs képernyőn 42% bounce. A replay-en a felhasználók a munka nevére kattintanak, de a sor nem nyílik ki. | A sor nem tűnik kattinthatónak | Az egész sor legyen kattintható, hover-effekttel | Bounce 42% → 20% alá | 0.1.0+… | |

---

## 7. A replay megnézése

Egy számot 3–5 konkrét munkamenet replay-e magyaráz meg. Mire figyelj:

- **Hol áll meg az egér?** A hosszú mozdulatlanság keresést vagy gondolkodást jelent,
  a kör alakú mozgás keresést.
- **Hová kattint válasz nélkül?** Ott valami kattinthatónak tűnik, de nem az.
- **Mit csinál közvetlenül a visszalépés előtt?** Mit keresett, amit nem talált meg?
- **Hány eszközváltás van egy objektumon belül?**
- **Mennyi idő telik el az első műveletig?** Betöltésre vár, vagy tájékozódik?

Ha a replay-ből sem derül ki az ok, **kérdezd meg a kollégát**. Egy ötperces
beszélgetés a replay mellett többet ér bármilyen újabb mérőszámnál.

---

## 8. Javasolt következő mérések

Ezek még nincsenek a rendszerben, fontossági sorrendben:

1. **Mennyit javít a reviewer a maszkon.** Az annotátor által beküldött és a reviewer
   utáni maszk voxel-különbsége. Ez a minőség objektív mérése, a szubjektív elutasítás
   helyett. Ehhez a két maszkot össze kell hasonlítani (MinIO-ból).
2. **Egyezés két annotátor között (Dice).** Ahol ugyanazt az esetet ketten annotálták.
   Megmutatja, mely címkék definíciója nem egyértelmű.
3. **Valódi képbetöltési idő.** Jelölő a viewerben, amikor az első szelet megjelent. Most
   az első műveletig eltelt idő közelíti.
4. **Címkénkénti idő.** Melyik címke (lézió-típus) rajzolása viszi az időt.
5. **Értesítéstől a munka megkezdéséig.** Mennyi idő telik el az értesítés és az eset
   megnyitása között. A várakozási idő egyik fő oka.
6. **Időszakos rövid kérdőív (NASA-TLX, 6 kérdés), negyedévente.** A kognitív terhelés
   validált mérése, ami kiegészíti az egykattintásos értékelést.
7. **Funkció-kapcsolók (A/B).** Egy új felület kapcsolható legyen fiókonként, így a
   két változat egy időben mérhető, és nem kell kiadásról kiadásra összehasonlítani.

---

## 9. Hol van mi a kódban

- A mérőszámok definíciói és küszöbértékei:
  - `services/admin-service/app/usage/stats.py`
  - `services/admin-service/app/usage/findings.py`
  - `services/admin-service/app/pipeline_health/`
- A tracker (mit rögzít a böngésző): `admin-ui/src/usage/tracker.ts`. Azonos
  másolata van a `ct-annotator/frontend/src/usage/` mappában.
- Ha egy küszöbérték vagy definíció változik, ezt a dokumentumot is frissíteni kell.
