# Solvetec TimeSave Social V17.15 · Meta Unified Login auf Render

## Was wurde implementiert?
- Neues **Meta Unified Login** mit `config_id` und isoliertem OAuth-State.
- Server tauscht Authorization Code gegen Meta-Token und sucht freigegebene Instagram-Konten.
- **Instagram ohne obligatorische Facebook-Seite**, aber mit Business-Portfolio und Meta Business Login-Konfiguration.
- Verbindung verschlüsselt und als `instagram`-Zielkonto gespeichert (bestehende Beitragsplanung kann Konto auswählen).
- Facebook-Login, altes Instagram-Login, TikTok, YouTube, Telegram, Kreativstudio und Videoeditor bleiben erhalten.
- Alte Facebook-Kontosynchronisierung überschreibt die neue Unified-Instagram-Verbindung nicht.
- Bei leerer Kontenliste bricht die Verbindung mit Erklärung ab, statt irgendetwas zu speichern.

## 1. GitHub aktualisieren
Lade den **INHALT** dieser ZIP (nicht `data`, keine `.env`) in das PRIVATE GitHub-Repository hoch: `app/main.py`, `static` (inkl. neuer `v1715.js`) und vorhandene Deployment-Dateien. Commit → Render Deploy latest commit.

## 2. Meta Weiterleitungsadresse
Nach dem Deploy: TimeSave Social → Einstellungen → Meta Unified Login. Die **exakt angezeigte Callback-URL** bei Meta → `API setup with Unified login` als OAuth Redirect URI registrieren.
Das Format ist: `https://<dein-render-service>.onrender.com/oauth/instagram_unified/callback`.
Verwende nicht den alten `/oauth/instagram/callback` und nicht die Shopify-URL.

## 3. Konfiguration
In Render → Webservice → Environment (bevorzugt für Demo, weil Daten auf Free flüchtig):
- `META_APP_ID`: Meta App-ID deiner App
- `META_APP_SECRET`: Meta App Secret (geheim)
- `INSTAGRAM_UNIFIED_CONFIG_ID`: die bereits erstellte `config_id`
WICHTIG: `ADMIN_TOKEN` bleibt unverändert. Keine Secrets auf GitHub hochladen.
Alternativ kannst du die drei Werte innerhalb TimeSave Social unter Einstellungen speichern. Auf Render Free gehen diese lokalen Einstellungen bei Neustarts verloren.

## 4. Test
TimeSave Social → Konten & Plattformen → „Instagram mit Unified Login verbinden“. Bei Meta Instagram-Unternehmensressourcen freigeben. Nach Callback wird eine Erfolgsmeldung angezeigt. Danach Verbindungen aktualisieren und Instagram API prüfen.
Wenn Meta bei `GET /me/assigned_instagram_accounts` keine Konten liefert: Meta-Business-Portfolio, Unternehmensressourcen und Berechtigungen prüfen. Eine freigegebene IG-Ressource in der UI ist nicht automatisch API-seitig abrufbar; Metas Verhalten kann variieren.

## Wichtige Sicherheit
Render Free: flüchtiges Dateisystem und Sleep. **Nicht für produktive Konten und automatische Veröffentlichungen verwenden.** Nur Testaccount/App-Rolle verwenden. Der Scheduler bleibt dort gesperrt. Zunächst die Testanmeldung prüfen, danach kostenpflichtigen Persistent Disk und zuverlässige Backups für Produktivbetrieb einrichten.

Weder OAuth-Token noch Meta App Secret an ChatGPT schicken. Ein erfolgreicher Offline-Test ersetzt keinen echten Meta-Login. Dieser muss mit deinem Meta-Testkonto erfolgen.
