// A campaign stores its photo as an absolute URL on the app's public address (the on-chain token metadata
// needs one). The pages load the app's own photos by relative path instead, so they show on any host
// (localhost, a preview deploy, a moved domain) and skip a cross-origin request. Other URLs pass through.
const OWN_PHOTO = /^https?:\/\/[^/]+(\/api\/images\/[0-9a-f]{32})$/;

export function imageSrc(url: string): string {
  const own = OWN_PHOTO.exec(url);
  return own ? own[1] : url;
}
