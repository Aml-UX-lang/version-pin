# Version Pin — Figma plugin

**Problem:** One Figma file holds v1, v2, "final", "final-final" of the same screen, or several pages of rounds. Developers can't tell which one to build, and designers don't want to delete old versions because they are the history.

**Solution:** Mark what is final, at the level of a single screen (frame) or a whole page. Version Pin makes it unmistakable everywhere a developer looks, tells the team when it changes, and never deletes anything.

## 1. Screens (frames)
- Select the versions of one screen → **Track** (numbered left to right). Mark one **Final**.
- Older versions and any previous final become **Superseded**. Newer drafts keep their status.
- On the canvas: a badge `FINAL · v3` / `v2 · SUPERSEDED → final is v3`, old frames dimmed, layer names `Login · v3 ✓ FINAL`, and only the final is **Ready for dev**.
- Duplicated frames are detected ("Untracked copy") and can be tracked as the next version.
- **Archive:** moves superseded frames to a `Version archive` page.

## 2. Pages
- **Pages tab:** give each page a status: Final, In review, Draft, Old, or none.
- Marking a page **Final** asks which pages it replaces; those become **Old** and point to the final page.
- Every page stays visible in the Pages panel, with the status in its name:
  `✅ FINAL – Onboarding`, `🟠 IN REVIEW – Onboarding round 3`, `⛔ OLD – Onboarding round 1`.
- A large banner at the top of each page: **NOT FINAL · OLD VERSION — Use the page "Onboarding" instead.** Frames on old pages are dimmed.
- **Archive old pages:** moves old pages below a divider at the bottom of the Pages panel. Changing a page's status back moves it above the divider again.

## 3. Being built
- Developers (in Dev Mode) or designers click **I'm building v3** / **I'm building this page**.
- Builders show on the canvas badge, in the panel and in the Pages tab.
- Designers get a warning before replacing something that is being built.
- When a version or page someone is building stops being final, that developer sees an alert in Version Pin: *"You're building Login v3. v4 is now the final version."*, with the change note and a **Switch to v4** button.

## 4. Slack / Microsoft Teams messages
Settings → Team notifications. Paste a **Slack incoming webhook** and/or a **Teams workflow URL** (Teams: Workflows app → "Post to a channel when a webhook request is received"). Click **Send test message**.

The plugin posts a message when:
- A screen version becomes final: `✅ Login: v4 is now FINAL (replaces v3). What changed: … ⚠️ Being built from an older version: Ahmed (v3). Please switch to v4.`
- A page becomes final, old or in review: `✅ Page "Onboarding" is now FINAL. Now old: "round 1", "round 2". ⚠️ Being built from an old page: Sara.`

The webhook URLs are saved in the file, so they are shared by every designer who uses the plugin on it. Each message includes a link to the frame or page once the plugin is published privately in your organization.

## Install (development)
1. Unzip this folder.
2. Figma desktop app → **Plugins → Development → Import plugin from manifest…** → choose `manifest.json`.
3. Run it from **Plugins → Development → Version Pin**, or from the Plugins tab in Dev Mode's inspect panel.

To publish for your organization, create the plugin in Figma to get a real `id`, replace `version-pin-local-dev` in `manifest.json`, and publish it as a private plugin.

## Known limits (to check during your first test in Figma)
- Some Dev Mode seats may not be allowed to write to the file. In that case **I'm building** is saved only on the developer's computer, and the plugin says so. A designer can add them instead.
- Slack is sent without a browser preflight, so it works from the plugin. Some Teams setups reject plugin requests; if the test message doesn't arrive, send it through a Power Automate flow or a small relay.
- Badges and banners sit next to the frames. If you move a frame, click **Refresh badges, banners and labels** in Settings.

## Files
- `manifest.json` — Design mode + Dev Mode, network access for Slack/Teams.
- `code.js` — plugin logic (no build step).
- `ui.html` — panel UI. Opened directly in a browser, it runs the same `code.js` against a mock Figma file as an interactive demo.
