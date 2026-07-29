# MSC-Mail mit Freigabe

Dieses Paket aktiviert den bereits getesteten Mail-Flow vollständig innerhalb
des laufenden OpenClaw-Containers. Lesen bleibt read-only, ein Entwurf wird
verschlüsselt gespeichert, Vinzenz prüft ihn über HTTPS und Passkey, und erst
danach darf der SMTP-Worker genau einen Versandversuch ausführen.

Nach Merge einmal im Gateway-Container ausführen:

```text
/home/node/.openclaw/workspace/msc/projects/MSC-Event-CLI/deployment/approved-mail/container-install.sh
```

Das Skript nutzt die bereits gemounteten MSC-Mailpasswörter unter
`/run/secrets`, fragt kein zusätzliches Passwort ab und legt Anwendung,
Konfiguration, Schlüssel sowie verschlüsselte SQLite-Datenbank ausschließlich
unter `/home/node/.openclaw/msc-approved-mail` ab. Es prüft den bestehenden
Read-only-Mailzugriff, baut das Plugin, validiert die OpenClaw-Konfiguration und
behält rückrollbare Sicherungen.

Die Approval-Seite wird direkt als native Gateway-Route unter
`/msc-approval` registriert. Es gibt keinen eigenen Port, keinen
Docker-Socket, kein Compose-Override und keine Caddy-Sonderroute. Das optionale
Plugin-Tool `msc_mail_reply_propose` liest die konkrete Ursprungsmail erneut
über den unveränderten Read-only-Provider und speichert nur einen
verschlüsselten Entwurf.

Das Installationsskript startet den Gateway bewusst nicht neu. Nach
erfolgreicher Vorbereitung ist genau ein sicherer, auf aktive Arbeit wartender
Gateway-Neustart erforderlich:

```text
openclaw gateway restart --safe
```

Anschließend zeigt das Skript den lokalen Befehl für einen zehn Minuten gültigen
Bootstrap-Code. Den Code auf der ausgegebenen `/msc-approval/register`-Seite
eingeben und den Passkey einmalig anlegen.

Keine Mail wird durch Installation oder Passkey-Einrichtung versendet. Jede
Mail braucht einen konkreten Entwurf und eine eigene Passkey-Freigabe. Der
Worker unternimmt pro freigegebener Outbox-Nachricht genau einen SMTP-Versuch.

Der Approval-Link enthält eine nicht erratbare Aktions-ID und wird nur über den
privaten Telegram-Chat zugestellt. Wer den Link bewusst weitergibt, gibt damit
auch die sichtbare Entwurfsvorschau weiter; ein Versand bleibt trotzdem ohne
Vinzenz' registrierten Passkey beziehungsweise Face ID unmöglich.
