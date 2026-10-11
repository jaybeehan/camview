# CamView

A bare-bones live-view page for your cameras, made to run in Docker on a NAS.
Add RTSP cameras and Eufy doorbells from the web page and watch them. Nothing is recorded.

```
Browser ──► CamView (port 8780) ──► go2rtc ──► RTSP cameras
                                        └────► CamView Eufy bridge ──► eufy-security-ws ──► Eufy doorbell (P2P)
```

- **go2rtc** does the video work (turns RTSP into something a browser can play, with ~0.5 s delay).
- **eufy-security-ws** signs in to your Eufy account and opens the doorbell's own P2P live stream,
  because most Eufy doorbells don't offer RTSP.
- **CamView** is the small page you use, plus the glue between the two.

Eufy doorbells only stream while a tile is actually showing them, so battery doorbells aren't kept awake.

## Install on Synology (from a phone browser)

1. **Make the image public (one time).** On GitHub: your profile → **Packages** → `camview` →
   **Package settings** → **Change visibility** → Public. The image holds no passwords; those
   live only in the compose file on your NAS.
2. **Make the folders** in File Station: `/docker/camview` and inside it an empty `data` folder.
3. **Container Manager → Project → Create.**
   - Project name: `camview`, Path: `/docker/camview`
   - Source: *Create docker-compose.yml*, paste [`docker-compose.yml`](docker-compose.yml)
   - Fill in the Eufy login (lines marked CHANGE), or delete the `eufy` section and set
     `EUFY_WS_URL: ""` if you have no Eufy devices.
4. **Next → Done.** Then open **http://NAS-IP:8780** and tap **+ Add camera**.

### Updating

Every push to `main` rebuilds the image on GitHub (Actions tab shows progress, ~2 min).
Then in Container Manager: **Project → camview → Action → Build** — `pull_policy: always`
makes it fetch the new image.

### Ports

Everything uses host networking. Only two ports are reachable from your network:
**8780** (the CamView page) and **8555** (WebRTC video). go2rtc's admin page, its RTSP re-share
and the Eufy bridge listen only inside the NAS, so the CamView password can't be bypassed.
go2rtc's admin page is still available, behind the password, at **http://NAS-IP:8780/go2rtc/**.
Change `PORT` in the compose file if 8780 clashes with something.

## Adding cameras

**RTSP / URL** — paste the camera's stream address. Typical formats:

| Camera | URL |
|---|---|
| Reolink | `rtsp://admin:PASS@IP:554/h264Preview_01_main` (or `_sub` for the low-res stream) |
| Hikvision / many ONVIF cams | `rtsp://admin:PASS@IP:554/Streaming/Channels/101` |
| Dahua / Amcrest | `rtsp://admin:PASS@IP:554/cam/realmonitor?channel=1&subtype=0` |
| TP-Link Tapo | `rtsp://USER:PASS@IP:554/stream1` (camera account set in the Tapo app) |
| Eufy cams with RTSP turned on | `rtsp://USER:PASS@IP:554/live0` |

If a grid of many cameras is heavy, use each camera's lower-resolution "sub" stream.

**Eufy device** — pick the doorbell from the list (it's filled in from your Eufy account). Leave
"Play automatically" off for battery doorbells; tap the tile when you want to look. Waking the
doorbell takes roughly 5–15 seconds.

**Find cameras** scans your home network (about 15–30 s) for anything serving RTSP video, plus
cameras that announce themselves over ONVIF, and tries the stream paths that common and cheap
cameras use. Enter a camera's username/password first. Most cameras won't share video without one,
and the scan stops after two rejected logins so it can't lock a camera. Found streams get an
**Add** button. Cameras on unusual RTSP ports can be included with the `SCAN_EXTRA_RTSP_PORTS`
setting (e.g. `"8001,9554"`) in the compose file.

**Edit** (top right) lets you rename, change, reorder (◀ ▶) or delete cameras. S / M / L sets tile size.
Click ⤢ on a tile for full screen; Esc to go back.

## Eufy notes

- **Use a second Eufy account.** Signing in with your main account from the NAS can sign your phone out.
  Make a new Eufy account, then in the Eufy app on your phone share your doorbell(s) with it
  (give it admin rights), accept the invite, and put that second account's login in `docker-compose.yml`.
- **Captcha / verification code:** if Eufy asks for one when the bridge signs in, a yellow box appears at
  the top of the CamView page — type the code there. This normally only happens the first time.
- `COUNTRY` is set to `CA`; change it if your Eufy account is registered elsewhere.
- The `eufy-security-ws` project was archived in September 2026 (work moved to a new library). Its
  last image still works today, but if Eufy changes their servers it may stop, and the doorbell tile
  will show nothing; RTSP cameras are unaffected.
- Some newer doorbells send H.265 video. Chrome/Edge on recent hardware and Safari can play it;
  Firefox can't.

## Files

| Path | What |
|---|---|
| `app/server.js` | CamView server (Node, no dependencies) |
| `app/public/index.html` | The web page |
| `Dockerfile`, `.github/workflows/docker.yml` | Image build, pushed to `ghcr.io/jaybeehan/camview` |
| `docker-compose.yml` | What you paste into Container Manager |

On the NAS, the shared `data` folder ends up holding `cameras.json` (your camera list),
`go2rtc.yaml` (go2rtc's settings, kept in step automatically) and `persistent.json` (Eufy sign-in).

## Security

Set `CAMVIEW_PASSWORD` in the compose file. The page then asks for it once per browser and stays
signed in for 90 days (**Sign out** button top right). Changing the password signs every browser
out. After five wrong guesses from one device it makes you wait 30 seconds per try.

The page is plain HTTP, which is fine at home. To look from outside, use the Synology VPN or
Tailscale rather than port-forwarding 8780. Opening it to the internet would send the password
unencrypted.

## Troubleshooting

- **Tile stays black / "error":** open http://NAS-IP:8780/go2rtc/ (go2rtc's page) → the stream → check its
  error. Most often the RTSP URL, username or password is wrong. Testing the URL in VLC helps.
- **Eufy pill says "bridge offline":** Container Manager → Container → camview-eufy → Log — usually wrong login or country.
- **Logs:** Container Manager → Container → camview → Log shows when doorbell streams start/stop and why.
