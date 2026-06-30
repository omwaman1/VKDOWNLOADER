# VKDOWNLOADER

A standalone bulk video downloader for ClassX courses. Automatically decrypts video streaming paths and XOR header keys using hardcoded keys, enabling high-quality, resume-capable direct downloads in `.mkv` format.

## Features
- Real-time Course Library folder tree mirroring the API.
- Bulk downloading with multiple concurrent streams.
- Auto-decryption (AES-128-CBC & XOR header decoding). No sniffer or URL capturing required!
- Byte-range resume support.
- Configurable qualities (720p, 480p, 360p, 240p).
- Premium dark-theme glassmorphism UI.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set your ClassX Authorization token at the top of `server.js` (`AUTH_TOKEN` variable).
3. Start the server:
   ```bash
   node server.js
   ```
4. Open `http://localhost:3000` in your web browser.
