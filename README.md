# Bauteile Suchen

Browser-PWA: Bauteil auf einem Bestückungsplan-PDF per pinkem Fadenkreuz finden.  
Version **V1.3.1**. Lizenz: **GPLv3**.

Orientiert an der Kalibrierungs- und Pick & Place-Logik von Bestückungsplan (unabhängige App).

## Starten

Statische Dateien — kein Build nötig:

```bash
cd bauteile-suchen
python3 -m http.server 5180
# → http://localhost:5180/
```

Oder Netlify Drop / GitHub Pages (`base` relativ, Manifest `id`/`start_url`/`scope`: `/bauteile-suchen/`).

## Nutzung

1. Menü → **Datei** → **Öffnen** (Projekt `.zip`) **oder** **Erstellen** → **Bestückungsplan PDF laden** / **Pick & Place CSV laden**
2. Kalibrierung (2 Referenzpunkte, Similarity wie Bestückungsplan):
   - Bauteil im Suchfeld (z. B. `FID1`) → auf dem Plan anklicken → **Kalibrierung setzen** (oder Menü → Referenzpunkt setzen)
   - Zweites Bauteil (z. B. `FID2`) ebenso
3. Bauteil suchen (z. B. `R1`) → pinkes Fadenkreuz (`#dd007a`, wie Button „Sichern“ in Bestückungsplan)
4. Menü → **Bestückungsvarianten**: Variante wählen / hinzufügen / entfernen (Name = Dateiname ohne Endung)
5. Optional Menü → **Stücklisten** → **SMD BG Stückliste laden** / **BG Stückliste laden** (PDF „Lager - Stückliste“):
   zum gefundenen Bauteil wird der Lagerplatz (über die BEAK-Nr.) rechts im Suchfeld angezeigt
6. Menü → **Sichern** speichert Plan + Pick & Place + Kalibrierung + Stücklisten als Projekt `.zip`
7. Menü → **Schließen** schließt das Dokument und zeigt wieder den Willkommensbildschirm

## Dateiformate

- PDF (Bestückungsplan); optional auch PNG/JPEG
- Pick & Place: CSV (PartID,X,Y,Side,…) oder Altium-Text (Designator / Center-X / Layer)
- **Projekt `.zip`**: normales ZIP (öffnet z. B. auch in iPhone Dateien). Ab V1.1 ist der Inhalt mit einem Code geschützt (ab V1.3: 6–10 Zeichen, Buchstaben und Zahlen, Groß/Klein beachten; ältere rein numerische Codes (z. B. „471108“) funktionieren weiter): `bauteile-suchen.json` (unverschlüsselt, nur Format-/Schlüsselparameter, keine Bauteildaten) und `projekt.enc` (AES-256-GCM, darin `projekt.json`, Plan, Pick & Place und Stücklisten). Schlüssel: PBKDF2-SHA256 (600 000 Iterationen) → HKDF pro Datei mit zufälligem Salt (WebCrypto). Auf dem Gerät wird nur ein nicht exportierbarer Schlüssel gespeichert, nie der Code; „Code auf diesem Gerät vergessen“ (Menü → Info) entfernt ihn. „Code ändern“ (Menü → Info) setzt einen neuen Geräte-Code (Eingabe + Bestätigung); bereits gespeicherte geschützte Dateien behalten ihren bisherigen Code und öffnen sich damit weiterhin. Ungeschützte `.zip` und ältere `.BSU`-Dateien lassen sich weiterhin öffnen.

## Lizenz

GPLv3 — siehe `LICENSE`.
