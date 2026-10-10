# Bauteile Suchen

Browser-PWA: Bauteil auf einem Bestückungsplan-PDF per pinkem Fadenkreuz finden.  
Version **V1.5.7**. Lizenz: **GPLv3**.

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

1. Menü → **Datei** → **Öffnen** (Projekt `.zip`) **oder** **Erstellen** → **Editiermenü** → Bestückungsplan PDF / Pick & Place CSV laden
2. Weitere Aktionen (Neu, Sichern, Varianten, Stücklisten, Kalibrierung, …) unter Menü → **Erstellen** → **Editiermenü**
3. Kalibrierung (2 Referenzpunkte, Similarity wie Bestückungsplan):
   - Bauteil im Suchfeld (z. B. `FID1`) → auf dem Plan anklicken → **Kalibrierung setzen** (oder Editiermenü → Referenzpunkt setzen)
   - Zweites Bauteil (z. B. `FID2`) ebenso
4. Bauteil suchen (z. B. `R1`) → pinkes Fadenkreuz (`#dd007a`, wie Button „Sichern“ in Bestückungsplan)
5. Menü → **Datei** → **Variante wählen**; weitere Varianten unter Editiermenü → Bestückungsvarianten
6. Editiermenü → **Pick & Place Werte mit Stückliste ersetzen (Kunden-Stückl. Referenz)**: Kunden-Stückliste (PDF, sortiert nach Referenz) — Toast „XX von YY Werten ersetzt“. Nicht gefundene Referenzen erscheinen als „n.b.“ (ohne BEAK/Lagerplatz). Die Ersetzung wird im Projekt mitgesichert.
7. Optional Editiermenü → **Stücklisten** → **SMD BG Stückl. laden (Lager-Stückl. Artikel-Bez.)** / **BG Stückl. laden (Lager-Stückl. Artikel-Bez.)** (PDF „Lager - Stückliste“):
   zum gefundenen Bauteil wird der Lagerplatz (über die BEAK-Nr.) rechts im Suchfeld angezeigt
8. Editiermenü → **Sichern** speichert Plan + Pick & Place + Kalibrierung + Stücklisten als Projekt `.zip`
9. Menü → **Datei** → **Schließen** schließt das Dokument und zeigt wieder den Willkommensbildschirm

## Dateiformate

- PDF (Bestückungsplan); optional auch PNG/JPEG
- Pick & Place: CSV (PartID,X,Y,Side,…) oder Altium-Text (Designator / Center-X / Layer)
- **Projekt `.zip`**: normales ZIP (öffnet z. B. auch in iPhone Dateien). Ab V1.1 ist der Inhalt mit einem Code geschützt (ab V1.3: 6–10 Zeichen, Buchstaben und Zahlen, Groß/Klein beachten; ältere rein numerische Codes (z. B. „471108“) funktionieren weiter): `bauteile-suchen.json` (unverschlüsselt, nur Format-/Schlüsselparameter, keine Bauteildaten) und `projekt.enc` (AES-256-GCM, darin `projekt.json`, Plan, Pick & Place und Stücklisten). Schlüssel: PBKDF2-SHA256 (600 000 Iterationen) → HKDF pro Datei mit zufälligem Salt (WebCrypto). Auf dem Gerät wird nur ein nicht exportierbarer Schlüssel gespeichert, nie der Code; „Code auf diesem Gerät vergessen“ (Editiermenü → Code) entfernt ihn. „Code ändern“ (Editiermenü → Code) setzt einen neuen Geräte-Code (Eingabe + Bestätigung); bereits gespeicherte geschützte Dateien behalten ihren bisherigen Code und öffnen sich damit weiterhin. Der Öffnen-Dialog bietet nur `.zip` an; ältere `.BSU`-Dateien können intern weiterhin gelesen werden, wenn sie anders bereitgestellt werden.

## Lizenz

GPLv3 — siehe `LICENSE`.
