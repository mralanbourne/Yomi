<p align="center">
  <img src="https://raw.githubusercontent.com/mralanbourne/Yomi/main/static/yomi_large.png" width="300" alt="Yomi Logo">
</p>

<h1 align="center">YOMI: Your Forbidden Gateway</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.1.5-e91e63.svg?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/Stremio-Addon-8a5a9e?style=for-the-badge&logo=stremio" alt="Stremio Addon">
  <img src="https://img.shields.io/badge/Status-Online-success?style=for-the-badge" alt="Status Online">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT">
  <img src="https://img.shields.io/badge/docker-ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white" alt="Docker Ready">
</p>

<p align="center">
  <strong>The definitive high-performance bridge between Sukebei and Stremio. Access the largest library of uncensored adult anime via Real-Debrid or Torbox with advanced episode parsing, subtitle injection, and zero server-side tracking.</strong>
</p>

<div align="center">
  <h3>🌐 Community Instance</h3>
  <a href="https://yomi.koyeb.app">yomi.koyeb.app</a>
  <br />
  <br />
  <a href="https://yomi.koyeb.app">
    <img src="https://img.shields.io/badge/INSTALL_NOW-CLICK_HERE-e91e63?style=for-the-badge&logo=rocket" alt="Install Button" height="55">
  </a>
</div>

<br />

> [!WARNING]
> ### ⚠️ MUST READ: Addon Quirks & How to Use
> Sukebei and Nyaa are the Wild West of anime releases. To use this addon effectively, you **need** to know these four things:
> 
> 1. 🎬 **The "Waiting" Video:** If you click an uncached stream (`☁️ DL`), Stremio will start playing a looping "Waiting/Loading" video. **This is not an error!** It means Yomi successfully sent the Torrent to Real-Debrid/Torbox and it is currently downloading to your cloud. <br /><br />**You can check this on your Debrid Dashboards.**<br /><br />
> 2. ⏳ **Refreshing Download Progress:** To see the live download progress directly in Stremio (e.g., `[⏳ 45%]`), you **MUST** back out of the episode screen and click the episode again. Stremio caches the stream list, so going back and forth forces it to fetch the latest percentage from the Yomi server!
> 3. 🧠 **Check the Stream Titles:** Uploaders use zero naming conventions. Yomi features a highly aggressive multi-stage parsing engine to find the exact episode you clicked on (even inside batches like `01-12`). However, because humans are unpredictable, it might guess wrong. **Always look at the `📄 Title` or `🎯 File` description** in the stream list to make sure you are selecting the right file!
> 4. 🖼️ **Text-Only Search Results:** During a global search, raw Sukebei results will appear as **text-only tiles** to keep the addon lightning fast. **This is not a bug!** The MyAnimeList poster, description, and episode count are fetched *the moment you click on the title*.

> [!IMPORTANT]
> ### 🔒 Privacy & Zero-Knowledge Security
> * Yomi is built on a **Stateless Architecture**. Unlike other addons, your sensitive data never touches a database.
> * **URL-Encoded Config:** Your Debrid keys are stored exclusively in your personal Manifest URL. Stremio handles the synchronization across your devices.
> * **Direct Resolution:** Stream links are resolved on-the-fly and redirected directly to your player.
> * **100% Open Source:** Your security is paramount. Verify the code yourself. Everything is public.
> * **Stateless Sync:** Because your keys are part of the URL, you only need to configure the addon **once**. Stremio will automatically sync **Yomi** to your Phone, Tablet, and TV.

### 🌙 Quick Start
1. Open the [Community Instance](https://yomi.koyeb.app) and enter your Real-Debrid and / or Torbox API Key.
2. Click "Install" to add your personalized configuration to Stremio.
3. Use the global Stremio search. Results will appear under the **"Yomi Search"** catalog.

### ✨ Key Features
* **🧠 Dual-Database Intelligence (AniList + MAL):** Yomi scrapes AniList for high-quality metadata. If an obscure release is missing, it automatically falls back to **MyAnimeList (Jikan API)** to fetch official posters, synopsis, and episode counts for raw Sukebei results.
* **💬 Universal Subtitle Proxy:** Bypasses Stremio's CORS limitations! Yomi detects `.ass`, `.srt`, `.vtt`, and `.ssa` files inside torrents, proxies them through the server, and injects them directly into your Stremio player as selectable tracks.
* **🎯 Embedded MKV Priority:** The engine automatically prefers `.mkv` files over `.mp4` when resolving episodes, ensuring you have access to embedded dual-audio and subtitle tracks.
* **⚡ Hybrid Debrid Support:** Full, seamless integration for both Real-Debrid and Torbox.
* **📦 Stateless & Lightweight:** Designed for high performance with near-zero overhead, ensuring lightning-fast catalog loading.
---

<details>
<summary>💻 <strong>Self-Hosting Instructions (Developers)</strong></summary>

### Hosting your own Gateway
Yomi is optimized for PaaS environments like Koyeb. It requires no persistent storage or database.

#### 1. Prerequisites
* **Node.js:** v18 or higher.

#### 2. Deployment (Docker)
1. **Clone the Repo:**
```
git clone [https://github.com/mralanbourne/Yomi.git](https://github.com/mralanbourne/Yomi.git)
cd Yomi
```
Build and Run:
```
docker build -t yomi-addon .
docker run -p 7000:7000 -e BASE_URL="[https://your-domain.com](https://your-domain.com)" yomi-addon
```
Environment Variables:

    BASE_URL: REQUIRED. The public URL of your deployment (e.g., https://yomi.yourdomain.com). 
  Yomi requires this to correctly construct the Subtitle-Proxy and Stream-Resolver links. If this is missing or incorrect, streams and subtitles will fail to load!

    PORT: Optional. Defaults to 7000.

#### 3. Customizing the "Waiting" Video
When users click on an uncached stream, Yomi routes the Stremio player to a fallback loading video while Debrid downloads the file.

    The repository includes the default waiting.mp4 file located in the /releases tab.

    If you want to use your own custom loading screen, simply host a new waiting.mp4 file before building your Docker image.

</details>

<p align="center">☕ Support

I maintain this instance for the community. If you enjoy unrestricted access to the Sukebei District, consider supporting the development!

<p align="center">
<a href="https://ko-fi.com/mralanbourne" target="_blank">
<img src="https://storage.ko-fi.com/cdn/kofi2.png?v=3" height="45" alt="Buy Me a Coffee at ko-fi.com" />
</a>
</p>
<p align="center">
Made with 🖤 for the Underground Community.
</p>
