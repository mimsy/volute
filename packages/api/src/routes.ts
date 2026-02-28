// Route path constants for /api/v1/

export const V1 = "/api/v1" as const;

export const routes = {
  // Auth
  auth: {
    login: `${V1}/auth/login`,
    register: `${V1}/auth/register`,
    logout: `${V1}/auth/logout`,
    me: `${V1}/auth/me`,
    users: `${V1}/auth/users`,
  },

  // Minds
  minds: {
    list: `${V1}/minds`,
    get: (name: string) => `${V1}/minds/${name}`,
    start: (name: string) => `${V1}/minds/${name}/start`,
    stop: (name: string) => `${V1}/minds/${name}/stop`,
    restart: (name: string) => `${V1}/minds/${name}/restart`,
    config: (name: string) => `${V1}/minds/${name}/config`,
    env: (name: string) => `${V1}/minds/${name}/env`,
    typing: (name: string) => `${V1}/minds/${name}/typing`,
    history: (name: string) => `${V1}/minds/${name}/history`,
    variants: (name: string) => `${V1}/minds/${name}/variants`,
    skills: (name: string) => `${V1}/minds/${name}/skills`,
    files: (name: string) => `${V1}/minds/${name}/files`,
    logs: (name: string) => `${V1}/minds/${name}/logs`,
    connectors: (name: string) => `${V1}/minds/${name}/connectors`,
    schedules: (name: string) => `${V1}/minds/${name}/schedules`,
    chat: (name: string) => `${V1}/minds/${name}/chat`,
  },

  // Conversations
  conversations: {
    list: `${V1}/conversations`,
    get: (id: string) => `${V1}/conversations/${id}`,
    messages: (id: string) => `${V1}/conversations/${id}/messages`,
    participants: (id: string) => `${V1}/conversations/${id}/participants`,
    events: (id: string) => `${V1}/conversations/${id}/events`,
  },

  // Unified SSE
  events: `${V1}/events`,

  // Unified chat
  chat: `${V1}/chat`,

  // Channels
  channels: {
    list: `${V1}/channels`,
    get: (name: string) => `${V1}/channels/${name}`,
    join: (name: string) => `${V1}/channels/${name}/join`,
    leave: (name: string) => `${V1}/channels/${name}/leave`,
    invite: (name: string) => `${V1}/channels/${name}/invite`,
    members: (name: string) => `${V1}/channels/${name}/members`,
  },

  // System
  system: {
    info: `${V1}/system/info`,
    restart: `${V1}/system/restart`,
    health: `${V1}/health`,
    logs: `${V1}/system/logs`,
  },

  // Shared resources
  env: `${V1}/env`,
  prompts: `${V1}/prompts`,
  skills: `${V1}/skills`,
  pages: `${V1}/pages`,
} as const;
