# MSC-Mail mit Freigabe

Dieses Paket aktiviert den bereits getesteten Mail-Flow als OpenClaw-Dienst:
Lesen bleibt read-only, ein Entwurf wird verschlüsselt gespeichert, Vinzenz
prüft ihn über HTTPS und Passkey, und erst danach darf der SMTP-Worker genau
einen Versandversuch ausführen.

Nach Merge auf dem Host einmal interaktiv ausführen:

```text
sudo /home/node/.openclaw/workspace/msc/projects/MSC-Event-CLI/deployment/approved-mail/host-install.sh
```

Das Skript nutzt die bereits installierten MSC-Mailkonten und deren vorhandene
Secret-Dateien. Neu abgefragt wird nur ein mindestens 16 Zeichen langes
Passwort, das den privaten Freigabepfad zusätzlich vor dem Passkey schützt.
Es baut ein unveränderlich gemountetes Produktionspaket, erzeugt getrennte
Schlüssel, aktiviert das Plugin, richtet die Caddy-Pfadroute ein, erstellt nur
den Gateway-Service neu und prüft Gateway, Plugin, Zugriffsschutz und Mail-Lesen.
Zusätzlich steht danach im Gateway der Befehl `msc` für Lesen und das Anlegen
eines konkreten Antwortentwurfs bereit.

Anschließend zeigt das Skript den lokalen Befehl für einen zehn Minuten gültigen
Bootstrap-Code. Den Code auf der ausgegebenen `/msc-approval/register`-Seite
eingeben und den Passkey einmalig anlegen.

Keine Mail wird durch Installation oder Passkey-Einrichtung versendet. Jede
Mail braucht einen konkreten Entwurf und eine eigene Passkey-Freigabe.
