# Solvetec TimeSave Social V17.16 – Render-Konfiguration reparieren

## Was war das Problem?
- Die bisherige Oberfläche zeigte bewusst **niemals** den Wert eines App Secrets an. Dadurch wirkte es, als sei er nicht gespeichert.
- Unified Login verwendet die `META_APP_ID` und `META_APP_SECRET` aus dem **Facebook-/Meta-Abschnitt**; der alte Direktlogin ist seit V18.2 für neue Anmeldungen deaktiviert.
- Die Python-Funktion `setting()` bevorzugte alte verschlüsselte SQLite-Werte gegenüber aktuellen Render-Umgebungsvariablen, auch bei leerem Eintrag. **Das ist korrigiert.** Auf Render sind vorhandene ENV-Werte jetzt maßgeblich.
- Der alte „Speichern“-Knopf sendete alle Formularfelder und überschrieb möglicherweise unbeabsichtigt Werte mit Leerstrings. Jetzt werden nur veränderte, nichtleere Felder gespeichert; bei Render Free bleibt Speicherung *nur vorübergehend*.

## Installation
Dieses ZIP enthält die vollständige App. Lade `app/` und `static/` sowie geänderte Konfigurationsdateien ohne `data/` und ohne `.env` in dein **privates** GitHub-Repository, Commit. Dein bestehender Render-Blueprint deployt dann von `main` oder starte `Manual Deploy → Deploy latest commit`. `ADMIN_TOKEN` nicht verändern.

## In Render hinterlegen
Render Dashboard → Webservice → Environment → **Environment Variables** (nicht Secret Files):
- `META_APP_ID` = Deine Meta-App-ID (nicht die Instagram-Konto-ID)
- `META_APP_SECRET` = Meta App Secret aus der gleichen Meta-App
- `INSTAGRAM_UNIFIED_CONFIG_ID` = Exakt die Configuration ID deiner Unified-Login-Konfiguration
Speichere mit **Save, deploy**. Diese Werte **nicht** im Chat, in GitHub oder in einer öffentlichen Datei posten.

## Diagnose in TimeSave Social
Nach erfolgreichem Deploy: TimeSave Social → Einstellungen → Meta Unified Login. Dort zeigt die App für jeden benötigten Eintrag ✅ oder ❌ an sowie dessen Herkunft, ohne geheime Werte auszugeben. Wenn alle vier (einschließlich HTTPS) grün sind, registriere die angezeigte Callback-URL bei Meta und starte den Login.

**Wichtig:** Noch kein Nachweis eines erfolgreichen echten Meta-Unified-Login oder Instagram-Reel-Uploads. Die Free-Version ist keine zuverlässige Produktionsumgebung (keine persistente SQLite-Disk; Publishing-Scheduler deaktiviert).
