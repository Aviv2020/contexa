export type Role = 'admin' | 'user';

export interface OrgSummary {
  id: string;
  name: string;
  mode: 'standalone' | 'connected';
  role: Role;
  jobTitle: string;
  unread?: number;
}

export interface OrgSettings {
  retentionMonths: number;
  autoLogoutMinutes: number;
  permissions: {
    usersCreateContexts: boolean;
    membersAddMembers: boolean;
    sendFiles: boolean;
    downloadAndShare: boolean;
    deleteMessages: boolean;
    archiveSave: 'all' | 'admins';
  };
  operatingHours: { enabled: boolean; days: number[]; start: string; end: string; timezone: string };
  mediaCacheMb: number;
}

export interface OrgInfo {
  org: { id: string; name: string; mode: string; ownerUserId: string; recoveryPublicKey: string | null };
  role: Role;
  mode: 'standalone' | 'connected';
  contextType: { label: string; labelPlural: string; icon: string; headerFields: { key: string; label: string }[] } | null;
  docTypes: { id: string; name: string }[];
  settings: OrgSettings;
  plugins: unknown[];
}

export interface OrgMember {
  id: string;
  name: string;
  jobTitle: string;
  role: Role;
}

export interface ArchiveMark {
  id: string;
  fileId: string;
  docTypeId: string;
  docTypeName: string | null;
  savedBy: string;
  savedAt: number;
  status: 'pending' | 'saved' | 'failed' | 'removed';
  removedAt: number | null;
  externalRef: string | null;
}

export interface ServerMessage {
  id: string;
  groupId: string;
  seq: number;
  rev: number;
  senderId: string;
  senderDeviceId: string;
  kind: 'text' | 'image' | 'document';
  ciphertext: string | null;
  keyVersion: number;
  replyTo: string | null;
  fileIds: string[];
  mentions: string[];
  clientId: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  archive: ArchiveMark[];
}

export interface GroupSummary {
  id: string;
  contextId: string;
  name: string;
  displayId: string;
  photoKey: string | null;
  header: Record<string, string>;
  archivedAt: number | null;
  managedBy: string | null;
  lastSeq: number;
  lastActivityAt: number;
  unread: number;
  pinned: boolean;
  mutedUntil: number;
  isMember: boolean;
  lastMessage: Pick<ServerMessage, 'id' | 'senderId' | 'kind' | 'ciphertext' | 'keyVersion' | 'createdAt' | 'deletedAt'> | null;
}

export interface GroupDetail {
  id: string;
  context: { id: string; name: string; displayId: string; photoKey: string | null; header: Record<string, string>; archivedAt: number | null; managedBy: string | null };
  lastSeq: number;
  keyVersion: number;
  minKeyVersion: number;
  isMember: boolean;
  membersManagedBy: string | null;
  canAddMembers: boolean;
  members: { id: string; name: string; jobTitle: string; role: Role; lastReadSeq: number; lastDeliveredSeq: number }[];
  me: { pinned: boolean; mutedUntil: number; lastReadSeq: number };
  archiveCount: number;
}
