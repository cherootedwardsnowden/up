# MetaUpload

Retro-style file hosting platform (2015/2016 aesthetic). Built with Node.js + Express.

## Features
- Login / Register system with JWT + HttpOnly cookies
- Role system: owner > mod > vip > free
- Free: 30MB/day | VIP: 1GB/day | Owner/Mod: Unlimited
- Video, Image, GIF uploads
- Premium mode: Videos capped at 15s preview for non-VIP
- Static thumbnail + hover GIF preview for videos
- Owner panel: user management, file management, config
- Owner panel restricted to IP: 176.42.131.129
- Non-browser client blocking (user-agent based)
- All data stored encrypted in JSON files (no SQL)
- Anti-hotlinking on video streams

## Deploy to Railway

1. Upload this folder to a GitHub repo
2. Create new Railway project from that repo
3. Set environment variables:
   - `JWT_SECRET` = any long random string
   - `DATA_KEY` = any long random string  
   - `NODE_ENV` = production
4. Deploy — Railway auto-detects Node.js

## Default Owner Login

Username: `owner`  
Password is derived from the server IP. Check server console on first boot for the hash info.  
To reset: use `/api/admin/resetpw` endpoint from owner IP with:
```json
{ "username": "owner", "newPassword": "yourNewPassword" }
```

## File Structure (all in one folder)
```
MetaUpload/
  server.js       — Backend (Express, auth, upload, admin routes)
  index.html      — Frontend (retro 2015-style UI)
  package.json    — Dependencies
  railway.json    — Railway config
  .gitignore
  mu_files/       — Created at runtime (uploaded files)
  mu_thumbs/      — Created at runtime (thumbnails)
  mu_data/        — Created at runtime (encrypted JSON DB)
```
