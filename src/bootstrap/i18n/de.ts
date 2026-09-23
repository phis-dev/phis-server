export const bootstrapDe = {
  languageLabel: "Sprache",
  title: "phis setup",
  subtitle:
    "Der Bootstrap-Modus ist aktiv. Mit diesem Ablauf wird die Runtime vorbereitet, bevor das eigentliche Admin verfügbar ist.",
  introEyebrow: "Bootstrap",
  stepLabel: "Schritt",
  statusComplete: "Abgeschlossen",
  statusCurrent: "Aktiv",
  statusUpcoming: "Offen",
  continueLabel: "GOOD TO KNOW",
  runtimeCheckRunLabel: "Checks starten",
  runtimeCheckRerunLabel: "Prüfungen erneut starten",
  runtimeCheckRunningLabel: "Prüfungen laufen...",
  runtimeCheckContinueLabel: "Weiter >",
  runtimeCheckVerifiedLabel: "Verifiziert",
  runtimeCheckWarningLabel: "Warnung",
  runtimeCheckFailedLabel: "Fehlgeschlagen",
  operatorDisplayNameLabel: "Name",
  operatorEmailLabel: "E-Mail",
  operatorPasswordLabel: "Passwort",
  operatorPasswordHint: "Mindestens 8 Zeichen und mindestens 1 Sonderzeichen.",
  operatorCreateLabel: "Create account >",
  operatorCreatingLabel: "Account wird angelegt...",
  operatorContinueLabel: "Weiter >",
  operatorSavedLabel: "Der Operator-Account ist jetzt konfiguriert.",
  operatorExistingDescription: "Vorhandene Operator-Accounts prüfen.",
  operatorUnnamedLabel: "Operator ohne Namen",
  operatorEnabledLabel: "Aktiv",
  operatorDisabledLabel: "Deaktiviert",
  operatorClearLabel: "Accounts löschen",
  operatorClearingLabel: "Lösche...",
  operatorClearWarning:
    "Dadurch werden alle konfigurierten Operator-Accounts aus phis-runtime.json entfernt.",
  operatorClearConfirm:
    "Sollen alle konfigurierten Operator-Accounts entfernt werden?",
  cancelLabel: "Abbrechen",
  translationChooseLabel: "Den Übersetzungsmodus für phis und die verwalteten Sites wählen.",
  translationAiLabel: "KI-gestützt mit DeepL",
  translationAiDescription:
    "Automatische Übersetzungen mit DeepL-Key und eigenem API-Endpunkt verwenden. Sowohl die phis-UI als auch verwaltete Sites können automatisch übersetzt werden, und Übersetzungen lassen sich jederzeit anpassen.",
  translationAiKeyLabel: "DeepL-Key",
  translationAiEndpointLabel: "API-Endpunkt",
  translationAiLinkBefore: "Get a free token at ",
  translationAiLinkLabel: "DeepL",
  translationAiLinkAfter: ".",
  translationAiLinkHref: "https://www.deepl.com/pro/change-plan#api",
  translationCdnLabel: "CDN, dann DeepL",
  translationCdnDescription:
    "Die Texte der Plattform zuerst bei cdn.phis.dev anfragen, den Rest bei DeepL. Ein DeepL-Schlüssel ist optional: ohne ihn wird die Oberfläche trotzdem übersetzt, nur Site-Inhalte und Konversationsnachrichten nicht.",
  translationAddonLabel: "Übersetzungs-Add-on",
  translationAddonDescription:
    "Die Übersetzung übernimmt der Service-Anbieter, den ein Add-on liefert und der Operator auswählt. Womit er arbeitet, ist seine Sache.",
  translationEnglishLabel: "UI englisch",
  translationEnglishDescription:
    "Admin- und Editor-UI bleiben englisch. Die Sites müssen Übersetzungen selbst verwalten.",
  translationContinueLabel: "Weiter >",
  databaseHostLabel: "Host",
  databasePortLabel: "Port",
  databaseNameLabel: "Datenbank",
  databaseUserLabel: "User",
  databasePasswordLabel: "Passwort",
  databaseSslLabel: "SSL-Modus",
  databaseSslDisableLabel: "Deaktiviert",
  databaseSslRequireLabel: "Erforderlich",
  databaseCurrentLabel: "Aktuelle Verbindung",
  databaseConnectionLabel: "Verbindungsdaten",
  databaseConnectionDescription:
    "Wenn bereits eine Datenbankverbindung konfiguriert ist, zeigt phis sie hier an und befüllt die Felder darunter vor.",
  databaseTestingLabel: "Verbindung wird geprüft...",
  databaseContinueLabel: "Weiter >",
  databaseErrorPrefix: "Datenbankfehler:",
  schemaStatusLabel: "Aktueller Schema-Status",
  schemaAppliedLabel: "Schema bereit",
  schemaTablesLabel: "Tabellen erkannt",
  schemaMissingLabel: "Noch kein phis-Schema erkannt.",
  schemaCreateLabel: "Tabellen anlegen >",
  schemaCreatingLabel: "Tabellen werden angelegt...",
  schemaContinueLabel: "Weiter >",
  schemaErrorPrefix: "Schemafehler:",
  siteCurrentLabel: "Aktuelle Sites",
  siteExistingDescription:
    "phis hat bereits eine oder mehrere konfigurierte Sites. Die Base-URLs können hier geprüft werden, bevor es zum letzten Review weitergeht.",
  siteDemoToggleLabel: "Demo-Site-Datensatz anlegen",
  siteDemoToggleHint:
    "Einen vorbereiteten Demo-Site-Eintrag in der phis-Datenbank anlegen. Dadurch wird noch kein Next.js-Projekt oder Deployment erzeugt.",
  siteCreateToggleLabel: "Neue Site anlegen",
  siteCreateToggleHint:
    "Jetzt bereits die erste echte verwaltete Site definieren und ihre Basisdaten direkt in der phis-Datenbank speichern.",
  siteKeyLabel: "Site-Key",
  siteNameLabel: "Site-Name",
  siteHostnameLabel: "Hostname",
  siteBaseUrlLabel: "Public Base URL",
  siteDefaultLocaleLabel: "Standard-Sprache",
  siteSupportEmailLabel: "Support-E-Mail",
  siteContinueLabel: "Weiter >",
  siteCreatingLabel: "Site-Setup wird gespeichert...",
  siteErrorPrefix: "Site-Fehler:",
  finishReviewLabel: "Review",
  finishOperatorsLabel: "Operator-Accounts",
  finishSitesLabel: "Konfigurierte Sites",
  finishTranslationLabel: "Übersetzungsmodus",
  finishDatabaseLabel: "Datenbank",
  finishInfrastructureHint:
    "Die Infrastruktur-Provisionierung ist noch nicht abgeschlossen. Runtime-, Webserver- und Deployment-Schritte werden nach dem Setup im Operator-Panel weitergeführt.",
  finishTermsLabel: "Terms & Conditions",
  finishTermsAcceptLabel: "Ich habe diese Bedingungen gelesen und akzeptiere sie.",
  finishTermsBody:
    "phis wird unter der GNU General Public License v3 oder höher vertrieben und im Rahmen dieser Lizenz ohne Gewährleistung bereitgestellt. Der Betreiber bleibt für Deployment, Konfiguration, Sicherheit, Backups und rechtliche Compliance selbst verantwortlich.",
  finishCompleteLabel: "Setup abschließen >",
  finishCompletingLabel: "Setup wird abgeschlossen...",
  finishErrorPrefix: "Abschlussfehler:",
  languages: {
    en: "English",
    de: "Deutsch",
  },
  runtimeChecks: {
    hostname: {
      title: "Hostname",
      description: "Prüfen, auf welchem Host- oder Container-Namen das Setup gerade läuft.",
    },
    platform: {
      title: "Plattform",
      description: "Betriebssystem und CPU-Architektur der aktuellen Runtime anzeigen.",
    },
    node: {
      title: "Node.js-Version",
      description: "Prüfen, ob eine brauchbare Node.js-Version für phis vorhanden ist.",
    },
    memory: {
      title: "Verfügbarer RAM",
      description: "Gesamt- und frei sichtbaren Arbeitsspeicher der aktuellen Runtime anzeigen.",
    },
    disk: {
      title: "Freier Speicherplatz",
      description: "Verfügbaren Speicherplatz im aktuellen Dateisystem prüfen.",
    },
    configStatic: {
      title: "Statische Config lesbar",
      description: "Prüfen, ob die getrackte Config vom laufenden phis-Prozess gelesen werden kann.",
    },
    configRuntime: {
      title: "Runtime-Config schreibbar",
      description: "Prüfen, ob die Runtime-Config durch Setup-Flows angelegt und geändert werden kann.",
    },
    cli: {
      title: "phis CLI",
      description: "Prüfen, ob der lokale phis-Befehl die Config-Validierung erfolgreich ausführen kann.",
    },
    containerized: {
      title: "Container-Modus",
      description: "Anzeigen, ob phis für eine containerisierte Umgebung konfiguriert ist.",
    },
  },
  steps: {
    locale: {
      title: "Setup-Sprache",
      summary:
        "Der Bootstrap muss lesbar bleiben, bevor DB-basierte Übersetzungen existieren.",
      description:
        "Das Setup muss ohne DeepL, ohne DB-Content und ohne die normale Übersetzungspipeline funktionieren. Deshalb bekommt die Setup-Shell eine kleine eingebaute Sprachumschaltung.",
      actions: [
        "Bootstrap-Texte nur aus lokalen Übersetzungsdateien rendern.",
        "Einen kompakten Sprachumschalter im Header der Setup-Card zeigen.",
        "Standard ist Englisch, Deutsch ist von Anfang an verfügbar.",
      ],
    },
    runtime: {
      title: "Runtime-Prüfungen",
      summary:
        "Zuerst prüfen, ob der Host phis überhaupt sauber ausführen kann.",
      description:
        "Zuerst die Host-Prüfungen ausführen, damit Runtime-Anforderungen, beschreibbare Config-Pfade, Plattformmodus und der grundlegende Setup-Zustand sichtbar sind, bevor Datenbankdetails erfasst werden.",
      actions: [
        "Die Prüfungen bewusst über den Aktionsbutton unten starten.",
        "Den Ergebnis-Stream prüfen, bevor es zur Datenbank-Konfiguration weitergeht.",
        "Harte Runtime-Fehler beheben, bevor der nächste Setup-Schritt beginnt.",
      ],
      goodToKnowTitle: "Open Source",
      goodToKnowBodyBeforeLink:
        "phis wird vollständig als Open-Source-Software unter GPLv3 veröffentlicht. Beiträge per Pull Request in ",
      goodToKnowLinkLabel: "GitHub",
      goodToKnowBodyAfterLink: " sind ausdrücklich willkommen.",
      goodToKnowLinkHref: "https://github.com/phisys-ltd/phis",
    },
    operator: {
      title: "Platform-Operator",
      summary:
        "Den operativen Account anlegen, der phis-Setup und Recovery-Flows jederzeit erreichen kann.",
      description:
        "Vorhandene Operator-Accounts prüfen oder jetzt den ersten anlegen.",
      actions: [
        "E-Mail, Anzeigename und Passwort erfassen.",
        "Nur einen Passwort-Hash in phis-runtime.json speichern.",
        "Spätere Verwaltung über die geplante phis CLI erlauben.",
      ],
      goodToKnowTitle: "Mit KI entwickelt",
      goodToKnowBodyBeforeLink:
        "phis wurde vollständig mit Hilfe von KI entwickelt und setzt bewusst auf modernste Technologien im gesamten Stack.",
    },
    translations: {
      title: "Übersetzungsmodus",
      summary:
        "Festlegen, wie phis UI-Übersetzungen und mehrsprachige Site-Unterstützung behandeln soll.",
      description:
        "Vor der ersten Site muss ein Übersetzungsmodus gewählt werden. DeepL braucht Zugangsdaten, CDN-Modus hängt von cdn.phis.dev ab, der Custom-Modus leitet an einen eigenen Endpoint weiter, und bei Englisch-only bleibt die UI englisch, während mehrsprachige Sites manuell übersetzt werden müssen.",
      actions: [
        "DeepL mit API-Key und Endpunkt.",
        "CDN-basierte Translation nur für die UI.",
        "Custom-Endpoint im phis-Übersetzungsformat.",
        "Englische UI mit Site-seitigen Übersetzungen.",
      ],
      goodToKnowTitle: "Übersetzungsstrategie",
      goodToKnowBodyBeforeLink:
        "phis cached DeepL-Übersetzungen in der eigenen Datenbank, sodass nur neue Übersetzungen überhaupt bei DeepL angefragt werden müssen.",
    },
    database: {
      title: "Datenbank-Verbindung",
      summary:
        "Die PostgreSQL-Verbindung für die phis-Control-Plane konfigurieren.",
      description:
        "Eine bereits konfigurierte Verbindung kann direkt weiterverwendet werden. Andernfalls wird sie jetzt erfasst. phis geht nur weiter, wenn Verbindung und Schreibzugriff auf der Zieldatenbank funktionieren.",
      actions: [
        "Host, Port, Datenbankname, User, Passwort, SSL-Modus.",
        "Verbindungstest über die Bootstrap-Verbindung.",
        "Klare Validierung vor dem nächsten Schritt.",
      ],
      goodToKnowTitle: "Integrierte Medusa-Unterstützung",
      goodToKnowBodyBeforeLink:
        "phis bringt bereits integrierte Unterstützung für Medusa-Stores mit und kann sie später im Setup als verwaltete Commerce-Backends anbinden.",
    },
    schema: {
      title: "Schema-Erstellung",
      summary:
        "Die initialen phis-Tabellen anlegen und prüfen, ob das Schema bereit ist.",
      description:
        "Dieser Schritt führt bei neuen Installationen das Bootstrap-SQL aus. Falls das phis-Schema bereits existiert, läuft das Skript idempotent und prüft nur die vorhandene Struktur.",
      actions: [
        "Datenbank anlegen, falls sie fehlt.",
        "Das phis-SQL-Bootstrap ausführen.",
        "Danach prüfen, ob die zentralen Tabellen lesbar sind.",
      ],
      goodToKnowTitle: "Plugin-Marketplace",
      goodToKnowBodyBeforeLink:
        "phis bringt ein Plugin-System für Themes, Layouts und Widgets mit. Drittanbieter können ihre Erweiterungen im Marketplace veröffentlichen und sogar monetarisieren.",
    },
    site: {
      title: "Erste Site",
      summary:
        "Optional direkt eine erste Site anlegen, damit die Plattform sofort nutzbar ist.",
      description:
        "Dieser Schritt sollte optional bleiben. Manche Installationen wollen zuerst nur die Control-Plane fertigstellen und Sites erst danach anlegen.",
      actions: [
        "Ja/Nein anbieten statt die Site-Erstellung zu erzwingen.",
        "Bei Ja: Key, Hostname, Lokalen, Mail-Identität und Public-Base-URL erfassen.",
        "Eine initiale Medusa-Anbindung kann später optional ergänzt werden.",
      ],
      goodToKnowTitle: "Multi-Site-ready",
      goodToKnowBodyBeforeLink:
        "phis speichert Site-Runtime-Daten in der eigenen Datenbank, sodass später weitere Sites ergänzt werden können, ohne die Plattform selbst neu zu bauen.",
    },
    finish: {
      title: "Prüfen und anwenden",
      summary:
        "Den gesammelten Setup-Status bestätigen und den Bootstrap-Modus schließen.",
      description:
        "Zum Schluss zeigt ein Review-Screen die gewählte Konfiguration, schreibt die letzten Runtime-Werte und erklärt die verbleibenden Nacharbeiten nach dem Setup.",
      actions: [
        "Eine abschließende Zusammenfassung zeigen.",
        "Config-Dateien atomar schreiben.",
        "Bootstrap deaktivieren, sofern er nicht bewusst für Recovery aktiv bleiben soll.",
      ],
      goodToKnowTitle: "Bootstrap-Übergabe",
      goodToKnowBodyBeforeLink:
        "Nach dem Abschluss des Setups übernimmt der normale Admin-Workflow. Infrastruktur-Provisionierung und Site-Runtime-Deployment laufen dann außerhalb des Bootstrap-Modus weiter.",
    },
  },
} as const;
