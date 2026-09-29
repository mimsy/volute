/** The commons' site name: an address, not a mind (see `COMMONS_MIND` in src/social.ts). */
export const COMMONS = "_commons";

/**
 * App route for a site. The commons lives under the Pages section; every other
 * site belongs to a mind and lives under that mind's page.
 */
export function siteRoute(name: string): string {
  return name === COMMONS ? `/pages/${COMMONS}` : `/minds/${name}/pages`;
}

/** App route for one page of a site. */
export function pageRoute(name: string, path: string): string {
  return `${siteRoute(name)}/${path}`;
}
