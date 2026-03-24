<p align="center">
  <img src="https://github.com/mralanbourne/Yomi/blob/main/static/yomi_large.png" width="300" alt="Yomi Logo">
</p>

<h1 align="center">YOMI: Your Forbidden Gateway</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-e91e63.svg" alt="Version">
  <img src="https://img.shields.io/badge/Stremio-Addon-8a5a9e?style=for-the-badge&logo=stremio" alt="Stremio Addon">
  <img src="https://img.shields.io/badge/Status-Online-success?style=for-the-badge" alt="Status Online">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT">
  <img src="https://img.shields.io/badge/docker-ready-2496ED.svg?logo=docker&logoColor=white" alt="Docker Ready">
</p>

<p align="center">
  <strong>The definitive high-performance bridge between Sukebei/Nyaa and Stremio. Access the largest library of uncensored adult anime via Real-Debrid or Torbox with zero server-side tracking.</strong>
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

> [!IMPORTANT]
> ### 🔒 Privacy & Zero-Knowledge Security
> * Yomi is built on a **Stateless Architecture**. Unlike other addons, your sensitive data never touches a database.
> * **URL-Encoded Config:** Your Debrid keys are stored exclusively in your personal Manifest URL. Stremio handles the synchronization across your devices.
> * **Direct Resolution:** Stream links are resolved on-the-fly and redirected directly to your player.
> * **100% Open Source:** Your security is paramount. Verify the code yourself—everything is public.

### ✨ Features
* **🔞 Adult AniList Integration:** Scrapes AniList specifically for adult-rated media to provide high-quality posters and metadata.
* **🏴‍☠️ Raw Sukebei Fallback:** If AniList lacks metadata, Yomi generates dynamic "Raw Result" tiles using reliable proxies to ensure you find every niche release.
* **⚡ Hybrid Debrid Support:** Full integration for both Real-Debrid and Torbox.
* **⏳ Live Download Progress:** Monitor real-time download percentages directly in the stream selection list.
* **🚀 Instant Cache Check:** Automatically prioritizes cached high-speed streams with a ⚡ symbol for instant playback.
* **📦 Stateless & Lightweight:** Designed for high performance with near-zero overhead, ensuring lightning-fast catalog loading.

### 📊 Monitoring Download Progress
Yomi provides real-time feedback on your Debrid downloads directly inside the Stremio interface:

* **Progress Indicator:** When a stream is not yet cached but currently downloading to your Debrid account, you will see a status like `[⏳ 45%] RD 1080p`.
* **Automatic Updates:** The addon is configured with a 5-second cache limit for active downloads, allowing the percentage to update frequently.
* **How to Refresh:** If the percentage appears stuck, simply back out of the "Streams" list to the meta description page and re-enter the stream list. This forces Stremio to fetch the latest progress from the Yomi server.

### 🌙 Quick Start
1.  **Configure:** Open the [Community Instance](https://yomi.koyeb.app) and enter your Real-Debrid or Torbox API Key.
2.  **Initialize:** Click "Install" to add your personalized configuration to Stremio.
3.  **Search:** Use the global Stremio search. Results will appear under the **"Yomi Search"** catalog.

> [!IMPORTANT]
> **Stateless Sync:** Because your keys are part of the URL, you only need to configure the addon **once**. Stremio will automatically sync **Yomi** to your Phone, Tablet, and TV.

---

<details>
<summary>💻 <strong>Self-Hosting Instructions (Developers)</strong></summary>

### Hosting your own Gateway
Yomi is optimized for PaaS environments like Koyeb. It requires no persistent storage / Database.

#### 1. Prerequisites
* **Node.js:** v18 or higher.

#### 2. Deployment (Docker)
1. **Clone the Repo:** <br />
```git clone [https://github.com/mralanbourne/Yomi.git](https://github.com/mralanbourne/Yomi.git)``` <br />
```cd Yomi```

    Build and Run:

```docker build -t yomi-addon``` <br />
```docker run -p 7000:7000 yomi-addon```

    Environment Variables:

        PORT: Defaults to 7000.

</details>

### ☕ Support
I maintain this instance for the community. If you enjoy unrestricted access to the Sukebei District, consider supporting the development!
<p align="center">
<a href="https://ko-fi.com/mralanbourne" target="_blank">
<img src="https://storage.ko-fi.com/cdn/kofi2.png?v=3" height="45" alt="Buy Me a Coffee at ko-fi.com" />
</a>
</p>
<p align="center">
Made with 🖤 for the Underground Community.
</p>
