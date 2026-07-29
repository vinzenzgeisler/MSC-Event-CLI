# MSC-Mail mit Freigabe

Dieses Paket aktiviert den bereits getesteten Mail-Flow vollständig innerhalb
des laufenden OpenClaw-Containers. Lesen bleibt read-only, ein Entwurf wird
verschlüsselt gespeichert, und erst eine separate OpenClaw-Freigabe von
Vinzenz im fest konfigurierten Telegram-Direktchat erlaubt genau einen
SMTP-Versandversuch.

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

Die bestehende Approval-Seite bleibt als native Gateway-Route unter
`/msc-approval` kompatibel, wird für den Telegram-Pfad aber nicht benötigt. Es
gibt keinen eigenen Port, keinen Docker-Socket, kein Compose-Override und keine
Caddy-Sonderroute. Das optionale Plugin-Tool `msc_mail_reply_propose` liest die
konkrete Ursprungsmail erneut über den unveränderten Read-only-Provider und
speichert nur einen verschlüsselten Entwurf. `msc_mail_reply_send` ist an den
exakten Session-Key `agent:main:telegram:direct:8261978945` gebunden.

Das Installationsskript startet den Gateway bewusst nicht neu. Nach
erfolgreicher Vorbereitung ist genau ein sicherer, auf aktive Arbeit wartender
Gateway-Neustart erforderlich:

```text
openclaw gateway restart --safe
```

Ein Bootstrap-Code oder Passkey ist für diesen Pfad nicht erforderlich. Jede
Mail braucht weiterhin einen konkreten verschlüsselten Entwurf, eine
vollständige Vorschau mit Payload-Referenz und eine eigene OpenClaw-Plugin-
Freigabe. OpenClaw bietet dabei ausschließlich `allow-once` oder `deny` an,
autorisiert den Telegram-Absender über `commands.ownerAllowFrom` und bindet
die Freigabe an Tool-Aufruf, Direktchat, Aktions-ID und Payload-Referenz.

Installation und Entwurfserstellung versenden keine Mail. Nach einer
`allow-once`-Entscheidung unternimmt der Worker pro Outbox-Nachricht genau
einen SMTP-Versuch. Unklare Providerergebnisse bleiben wie bisher
`uncertain` und werden nicht automatisch wiederholt.
