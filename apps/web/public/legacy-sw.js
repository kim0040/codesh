// legacy codesh name (1.0.x); remove in 2.0
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name.startsWith("codesh-")).map((name) => caches.delete(name)),
        ),
      ),
  );
});
