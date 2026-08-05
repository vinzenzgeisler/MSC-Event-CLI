# MSC-Mail mit Freigabe

Dieses Paket aktiviert den bereits getesteten Mail-Flow vollständig innerhalb
des laufenden OpenClaw-Containers. Lesen bleibt read-only, ein Entwurf wird
verschlüsselt gespeichert, und erst eine separate OpenClaw-Freigabe von
Vinzenz in einer von zwei exakt konfigurierten Direktsitzungen erlaubt genau
einen SMTP-Versandversuch: dem bestehenden Telegram-Direktchat oder der
authentifizierten WebChat-Konversation.

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
`/msc-approval` kompatibel, wird für den nativen OpenClaw-Pfad aber nicht benötigt. Es
gibt keinen eigenen Port, keinen Docker-Socket, kein Compose-Override und keine
Caddy-Sonderroute. Das optionale Plugin-Tool `msc_mail_reply_propose` liest die
konkrete Ursprungsmail erneut über den unveränderten Read-only-Provider und
speichert nur einen verschlüsselten Entwurf. Der reale RFC-Preview des
Providers wird dabei nur im begrenzten Headerbereich ausgewertet.
`msc_mail_reply_send` ist an genau zwei Session-Keys gebunden:
`agent:main:telegram:direct:8261978945` und
`agent:main:dashboard:a08cd2c0-a3db-4175-8069-2e6c1aee7842`. Andere
Dashboard-Konversationen, Gruppen und unbekannte Sessions werden abgewiesen.

Für Nennungen registriert dasselbe Plugin zwei schmale Read-only-Tools:
`msc_event_entries_list` erlaubt ausschließlich Event-, Annahmestatus- und
Klassenfilter sowie begrenzte Cursor-Paginierung; `msc_event_classes_list`
listet ausschließlich die Klassen einer konkreten Event-UUID. Beide laufen
über den festen `msc-event-readonly`-Wrapper. Freie HTTP-Pfade, Methoden, URLs,
SQL oder JSON-Bodies sind nicht Teil ihres Vertrags. Eine atomare Klassen- und
Startnummern-Zuweisung wird separat als verschlüsselter
`msc_event_entry_change_propose`-Vorschlag angelegt und nur über
`msc_event_entry_change_execute` nach `allow-once` ausgeführt. Der genehmigte
Payload erzwingt `sendSystemMail: true`, zeigt `requestCodriverData` ausdrücklich
an und fordert gemeinsam `entries.status.write` und `communication.write` an.

Antworten erhalten zentral die verifizierte Signatur von Vinzenz. Beim Konto
`msc-nennung` wird zusätzlich dieses Konto selbst als BCC-Empfänger gebunden.
Signatur und BCC sind Teil des verschlüsselten Approval-Payloads und werden in
der nativen Freigabe vollständig angezeigt.

Der Posteingangswächter läuft als isolierter OpenClaw-Cronjob alle fünf
Minuten. Sein Trigger steht in `inbox-watcher-trigger.js`; er liest ausschließlich
die drei INBOX-Listen über `/usr/local/bin/msc-mail-readonly`, speichert nur
Nachrichten-IDs und meldet ausschließlich neue, extern eingegangene IDs. Beim
ersten Lauf nach einer Trigger-Versionierung wird nur ein Ausgangsstand
gebildet, damit alte Nachrichten keine Freigabeflut auslösen. Der isolierte
Agent darf Quellen prüfen und verschlüsselte Antwortentwürfe anlegen, aber
niemals selbst senden.

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
autorisiert den Telegram-Absender weiterhin über `commands.ownerAllowFrom`;
WebChat muss die exakt konfigurierte authentifizierte Dashboard-Sitzung sein.
Beide Pfade binden die Freigabe an Tool-Aufruf, Session, einmalige Nonce,
Aktions-ID und Payload-Referenz. Die Nonce verfällt nach 60 Sekunden, wird auch
bei einem Fehlversuch verbraucht und kann weder durch ein späteres allgemeines
„Ja“ noch für eine andere Aktion wiederverwendet werden.

Installation und Entwurfserstellung versenden keine Mail. Nach einer
`allow-once`-Entscheidung unternimmt der Worker pro Outbox-Nachricht genau
einen SMTP-Versuch. Unklare Providerergebnisse bleiben wie bisher
`uncertain` und werden nicht automatisch wiederholt.
