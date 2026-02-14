export type ParsedTarget = {
  platform: string;
  identifier: string;
  uri: string;
  isDM: boolean;
};

export function parseTarget(target: string): ParsedTarget {
  const colonIdx = target.indexOf(":");
  if (colonIdx !== -1) {
    const platform = target.slice(0, colonIdx);
    const identifier = target.slice(colonIdx + 1);
    return {
      platform,
      identifier,
      uri: target,
      isDM: identifier.startsWith("@"),
    };
  }

  if (target.startsWith("@")) {
    return {
      platform: "volute",
      identifier: target,
      uri: `volute:${target}`,
      isDM: true,
    };
  }

  return {
    platform: "volute",
    identifier: target,
    uri: `volute:${target}`,
    isDM: false,
  };
}
