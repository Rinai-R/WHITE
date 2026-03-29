/**
 * Normalize an asset path to an absolute URL.
 * - HTTP/HTTPS URLs are returned as-is.
 * - Paths already starting with "/" are returned as-is.
 * - Relative paths are prefixed with "/".
 * - Empty/null paths return the provided fallback.
 */
export function getAssetPath(path: string, fallback = ""): string {
	if (!path) return fallback;
	if (path.startsWith("http://") || path.startsWith("https://")) return path;
	return path.startsWith("/") ? path : `/${path}`;
}
