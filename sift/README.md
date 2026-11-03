# Sift: a photo organizer that uses Jev

Sift sorts, tags, cleans up and searches your photos. It runs in your browser, and your photos stay on your computer. When you choose **Analyze**, Sift sends a small resized copy of each photo to [Jev](https://docs.typesafe.ai) (TypeSafe's decision model), and Jev answers a set of typed questions about it.

## Quick start

```bash
cd sift
export TYPESAFE_API_KEY="your-key"   # or paste the key in Settings later
python3 server.py
```

Then open **http://localhost:8765** and drag in some photos or a whole folder.

To try it without using any of your API usage: `python3 server.py --demo` (Jev's answers are made up).

You don't need to install anything. The server only uses Python's standard library.

## What it does

| Feature | How |
| --- | --- |
| **Smart albums** | Jev picks one scene for each photo (People, Pets, Food, Nature, Documents…). |
| **Auto-tags** | 21 yes/no questions (dog, beach, sunset, receipt, screenshot, kids…). A tag is added when Jev's probability is above your threshold. |
| **Quality score** | Jev rates each photo from Unusable to Great. You can sort or filter by it. |
| **Ask Jev search** | Type something like "birthday cake with candles". Jev looks at the pictures themselves and ranks matches. You can save the results as an album. |
| **Smart tags** | Teach it your own things ("Max the dog") with a description and/or an example photo. |
| **Cleanup** | Duplicates and near-duplicates (found on your computer, no API calls), blurry shots, closed eyes, screenshots, receipts, and photos with sensitive info like cards or IDs. |
| **Instant search** | Tags, scenes, colors, camera, month/year and album names. No API calls. |
| **Organize** | Favorites, albums, manual tags, bulk select (shift-click), ZIP download, CSV export. |

Keyboard shortcuts: `/` search · `←` `→` move between photos · `F` favorite · `I` info panel · `Esc` close · `Ctrl/Cmd+A` select all.

## Keeping usage low

- Nothing is sent to Jev until you click **Analyze** or **Ask Jev**. Sift always tells you how many requests it's about to make.
- Each photo is analyzed in **one** request that asks every question at once. Jev is designed to work this way, so it's cheaper than asking one question per request.
- Searches and smart tags send 4 small previews per request.
- You can change the analysis image size (512/768/1024px), and Settings shows how many requests and tokens you've used.
- Changing the tag threshold re-uses the answers Jev already gave you, so it costs nothing.

## How the pieces fit

```
browser (index.html + js/)  ──►  server.py (localhost)  ──►  api.typesafe.ai
   photos, tags, albums             adds your API key           Jev answers
   stored in IndexedDB              (browsers can't call
                                     Jev directly - CORS)
```

- `server.py`: serves the app and forwards requests to Jev. It has lots of comments and is a good file to learn from.
- `js/jev.js`: the questions Sift asks Jev and how requests are built.
- `js/imageutils.js`: EXIF reading, thumbnails, duplicate hashes and color palettes.
- `js/app.js`: the interface.

To use Sift from your phone or another computer on your Wi-Fi, run `python3 server.py --host 0.0.0.0` and open `http://<your-computer's-ip>:8765`. This works well on a Raspberry Pi.

Notes: image support on Jev is marked "dreamer-ready" (experimental) by TypeSafe, so accuracy may change between model versions. HEIC photos only import in Safari; in other browsers, convert them to JPEG first.
