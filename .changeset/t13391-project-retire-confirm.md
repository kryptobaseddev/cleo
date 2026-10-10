---
id: t13391-project-retire-confirm
tasks: [T13391]
kind: feat
summary: a project-stream pull confirms replica retires from the server's project replica listing
---

A pull of a project stream now reads `retiredAt` and `successor` from E15 `GET /v1/projects/:projectId/replicas`, following every page, and confirms the matching `retire` txns before apply, the same way a global pull reads the home listing (T13366). A confirmed retire takes the replica out of the fold horizon and turns its late txns into history. A server without retirement fields or without the listing confirms none, and a listing that fails warns and confirms nothing that round (T13395).
