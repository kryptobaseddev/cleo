---
id: t13570-pause-not-overdue
tasks: [T13570]
kind: fix
summary: "A cleo run paused under memory pressure is never reported overdue for the pause"
---

The hung/overdue watchdog (T13563) counted a pause still in progress as run
time, because the pause was only subtracted when the run resumed. A long
pressure pause could report a merely paused run as `overdue`. The pause in
progress is now subtracted too, in the check and in the notice.
