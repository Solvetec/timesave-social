# TimeSave Social by Solvetec – Version 21.1

## Neu: Video-Schnellstart nach der ersten Anmeldung

- Die Einführungsansicht öffnet sich nach dem erfolgreichen Login, wenn das Benutzerkonto die Anleitung noch nicht abgeschlossen hat. Das funktioniert auch nach PWA-Installation auf dem Handy.
- Der Nutzer kann zunächst die Anleitung schließen („Später fortfahren“) oder über drei Navigationseinträge Plattformen, Mediathek und Beitragsplanung öffnen.
- Mit „Einrichtung abschließen“ wird die Einführung pro Benutzerkonto verschlüsselt in der vorhandenen Datenbank als erledigt gespeichert; danach erscheint sie nicht mehr automatisch.
- Unter **Einstellungen > Erste Schritte & Video-Anleitung** kann der Benutzer sie erneut öffnen und die automatische Begrüßung zurücksetzen.
- Für die spätere Produktion einer Video-Anleitung: öffentliche MP4-Datei als `static/onboarding/einrichtung.mp4` hinzufügen und neu deployen. Die App zeigt dann einen Player und einen Downloadlink. **Die Datei fehlt absichtlich im Paket**, weil noch kein Erklärvideo aufgenommen/mitgeliefert wurde.
- Video nur mit fiktiven Accounts, anonymisierten Screenshots und **ohne echte Zugangsdaten, Tokens oder Kundendaten** aufnehmen; die MP4 ist öffentlich erreichbar. Auf Dauer großen Video-Content per Cloud-Storage/CDN ausliefern.

## Neu: Abomodell-Vorbereitung

- Unter Einstellungen erscheint „Tarife & Mitgliedschaft“ mit **ausdrücklich unverbindlichen** Vorschlagspreisen: Starter 12,90 €, Pro 24,90 €, Team 49,90 € pro Monat.
- Backend liefert einen schreibgeschützten Entwurf über `GET /api/billing/overview`; eine Tabelle `billing_subscriptions` reserviert den Platz für die spätere Zuordnung von bezahlten Abos und verifizierten Statusänderungen.
- **Kein Checkout, keine Zahlung, keine automatische Abbuchung, keine Paywall und keine Tariflimits in Version 21.1.** Deshalb darf Version 21.1 nicht als fertige Bezahl-App vermarktet werden.
- Später: Authentifizierte Stripe-Checkout-Sessions für direkte PWA-/Website-Käufe, verifizierte Stripe-Webhooks und Kundenportal. Für Store-Distribution: die für den jeweiligen Store/Region geltenden In-App-Payment-Vorschriften separat erfüllen. Keine Kaufberechtigungen anhand von Frontend-Angaben setzen.
- Zahlungs- und Rechnungssystem erst aktivieren, wenn Speicher, Backups, Datenschutz, Widerruf/Kündigung, Steuern und Live-Kosten geklärt sind.

## Veröffentlichen

1. Das ZIP vollständig über den bestehenden Quellcode der Anwendung übernehmen (neu insbesondere `static/v211.js`, `static/v211.css`, `static/onboarding/ANLEITUNG.txt`, Änderungen in `static/index.html`, `app/main.py`, `static/sw.js`).
2. Private Zugangsdaten, `data/`, `.env`, lokale Datenbanken oder laufende Schlüsseldateien nicht hochladen oder überschreiben.
3. Vor Installation auf echten Konten einmal mit einem Testbenutzer anmelden und kontrollieren: Video-Platzhalter erscheint; „Später“ schließt das Dialogfenster; nach „Einrichtung abschließen“ erscheint es nach erneutem Login nicht automatisch; unter Einstellungen lässt es sich öffnen.
4. Wichtig: Render-Free-Daten sind nicht dauerhaft. Die Erledigt-Markierung kann dort nach Deploy/Neustart wieder verloren gehen. Für echte Kunden PostgreSQL oder anderen persistenten Speicher und verlässliche Backups verwenden.

## Lokale Funktionsprüfung

- Python `py_compile` für `app/main.py` und `app/db.py`: erfolgreich.
- Node.js `--check` für `static/v211.js`: erfolgreich.
- FastAPI-Testclient: Unauthentifizierte Zugriffe auf Onboarding gesperrt, Status lesen/speichern/zurücksetzen, Billing-Entwurf abrufen und statische Dateien erreichbar: erfolgreich.
- Reale Interaktion auf Render und im mobilen Browser noch zu prüfen; kein echter Zahlungsprovider eingebunden.
