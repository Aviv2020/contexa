import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError } from '../../../src/api/client';
import type { GroupDetail } from '../../../src/api/types';
import { EDIT_WINDOW_MS } from '../../../src/config';
import type { LocalMessage } from '../../../src/db/local';
import { formatDay, useI18n } from '../../../src/i18n';
import { prepareDocument, prepareImage, uploadPrepared } from '../../../src/media/files';
import { bus } from '../../../src/state/events';
import { useSession } from '../../../src/state/session';
import { newClientId } from '../../../src/sync/engine';
import { Composer, type PickedAsset } from '../../../src/ui/chat/Composer';
import { MediaViewer, type FileMeta } from '../../../src/ui/chat/Media';
import { MessageBubble } from '../../../src/ui/chat/MessageBubble';
import { SaveToArchiveSheet } from '../../../src/ui/chat/SaveToArchive';
import { Avatar, Muted } from '../../../src/ui/kit';
import { useTheme } from '../../../src/ui/theme';

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, locale, s } = useI18n();
  const th = useTheme();
  const { engine, org, members, memberName } = useSession();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [limit, setLimit] = useState(50);
  const [replyTo, setReplyTo] = useState<LocalMessage | null>(null);
  const [editing, setEditing] = useState<LocalMessage | null>(null);
  const [viewer, setViewer] = useState<FileMeta | null>(null);
  const [saving, setSaving] = useState<{ m: LocalMessage; fileIds: string[] } | null>(null);
  const [removed, setRemoved] = useState(false);
  const [moreHistory, setMoreHistory] = useState(true);

  const reloadLocal = useCallback(async () => {
    if (!engine || !id) return;
    setMessages(await engine.db.messages(id, limit));
  }, [engine, id, limit]);

  const reloadDetail = useCallback(async () => {
    if (!id) return;
    try {
      setDetail(await api.get<GroupDetail>(`/v1/groups/${id}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setRemoved(true);
    }
  }, [id]);

  useEffect(() => {
    void reloadLocal();
  }, [reloadLocal]);
  useEffect(() => {
    void reloadDetail();
    if (engine && id) {
      void engine.retryUndecryptable(id);
      // Admins (or a fresh device) may not have this group's history locally yet.
      void engine.db.oldestSeq(id).then((s0) => (s0 === null ? engine.loadOlder(id) : undefined)).catch(() => undefined);
    }
  }, [reloadDetail, engine, id]);
  useEffect(() => bus.on('messages', (e) => {
    if (!e.groupIds.length || e.groupIds.includes(id!)) {
      void reloadLocal();
      void reloadDetail();
    }
  }), [id, reloadLocal, reloadDetail]);
  useEffect(() => bus.on('removedFromGroup', (e) => e.groupId === id && setRemoved(true)), [id]);

  // Mark as read while the chat is open (batched + debounced in the engine).
  useEffect(() => {
    if (!engine || !id || !detail?.isMember) return;
    const max = messages.reduce((n, m) => Math.max(n, m.seq), 0);
    if (max) engine.queueReceipt(id, { readSeq: max });
  }, [messages, engine, id, detail?.isMember]);

  const profiles = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberNames = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m.name])), [members]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const others = detail?.members.filter((m) => m.id !== engine?.userId) ?? [];
  const label = org?.contextType?.label ?? '';
  const readOnly = removed || !!detail?.context.archivedAt || (detail ? !detail.isMember : false);
  const canArchive = org ? org.settings.permissions.archiveSave === 'all' || org.role === 'admin' : false;

  const receiptOf = (m: LocalMessage): 'none' | 'sent' | 'delivered' | 'read' => {
    if (m.status !== 'sent' || !others.length) return 'sent';
    if (others.every((o) => o.lastReadSeq >= m.seq)) return 'read';
    if (others.every((o) => o.lastDeliveredSeq >= m.seq)) return 'delivered';
    return 'sent';
  };

  const send = async (text: string, mentions: string[], assets: PickedAsset[], originalQuality: boolean) => {
    if (!engine || !id) return;
    const replyId = replyTo?.id.startsWith('local:') ? null : replyTo?.id ?? null;
    setReplyTo(null);
    try {
      if (!assets.length) return await engine.send(id, { kind: 'text', payload: { text }, replyTo: replyId, mentions });
      const images = assets.filter((a) => a.kind === 'image');
      const docs = assets.filter((a) => a.kind === 'document');
      if (images.length) {
        const files = [];
        for (const a of images) files.push(await uploadPrepared(id, await prepareImage(a.uri, a.name, originalQuality)));
        await engine.send(id, { kind: 'image', payload: { text: docs.length ? undefined : text || undefined, files }, fileIds: files.map((f) => f.id), replyTo: replyId, mentions }, newClientId());
      }
      for (const d of docs) {
        const f = await uploadPrepared(id, await prepareDocument(d.uri, d.name, d.mime, d.size));
        await engine.send(id, { kind: 'document', payload: { text: text || undefined, files: [f] }, fileIds: [f.id], mentions }, newClientId());
      }
    } catch (e) {
      const err = e as ApiError;
      Alert.alert(t('error'), err.code === 'file_too_large' ? t('fileTooLarge') : err.code);
    }
  };

  const onLongPress = (m: LocalMessage, file?: FileMeta) => {
    if (m.status === 'pending' || m.deletedAt) return;
    const mine = m.senderId === engine?.userId;
    const fresh = Date.now() - m.createdAt < EDIT_WINDOW_MS;
    const unsaved = (m.payload?.files ?? []).filter((f) => !m.archive.some((a) => a.fileId === f.id && !a.removedAt));
    const items: { label: string; run: () => void; destructive?: boolean }[] = [];
    if (unsaved.length && canArchive && !readOnly) items.push({ label: t('saveToArchive', { label }), run: () => setSaving({ m, fileIds: file ? [file.id] : unsaved.map((f) => f.id) }) });
    if (file && !unsaved.some((f) => f.id === file.id)) {
      const a = m.archive.find((x) => x.fileId === file.id);
      if (a) items.push({ label: t('alreadySaved', { name: memberName(a.savedBy), time: formatDay(a.savedAt, locale, s) }), run: () => undefined });
    }
    if (!readOnly) items.push({ label: t('reply'), run: () => setReplyTo(m) });
    if (mine && fresh && !readOnly && m.payload?.text !== undefined) items.push({ label: t('edit'), run: () => setEditing(m) });
    if (mine && fresh && !readOnly && org?.settings.permissions.deleteMessages) {
      items.push({ label: t('delete'), destructive: true, run: () => Alert.alert(t('areYouSure'), undefined, [{ text: t('cancel'), style: 'cancel' }, { text: t('delete'), style: 'destructive', onPress: () => engine?.remove(m).catch((e) => Alert.alert(t('error'), (e as ApiError).code)) }]) });
    }
    if (mine) items.push({ label: t('info'), run: () => showReceipts(m) });
    items.push({ label: t('cancel'), run: () => undefined });
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ options: items.map((i) => i.label), cancelButtonIndex: items.length - 1, destructiveButtonIndex: items.findIndex((i) => i.destructive) }, (i) => items[i]?.run());
    } else Alert.alert('', undefined, items.map((i) => ({ text: i.label, onPress: i.run, style: i.destructive ? 'destructive' : i.label === t('cancel') ? 'cancel' : 'default' })));
  };

  const showReceipts = async (m: LocalMessage) => {
    const r = await api.get<{ receipts: { userId: string; read: number; delivered: number }[] }>(`/v1/messages/${m.id}/receipts`);
    const others2 = r.receipts.filter((x) => x.userId !== engine?.userId);
    const read = others2.filter((x) => x.read).map((x) => memberName(x.userId));
    const delivered = others2.filter((x) => x.delivered && !x.read).map((x) => memberName(x.userId));
    Alert.alert(t('info'), `${t('readBy')}: ${read.join(', ') || '—'}\n${t('deliveredTo')}: ${delivered.join(', ') || '—'}`);
  };

  const loadMore = async () => {
    if (!engine || !id) return;
    setLimit((l) => l + 50);
    if (moreHistory && messages.length >= limit - 1) setMoreHistory(await engine.loadOlder(id).catch(() => false));
  };

  const memberLine = detail ? detail.members.slice(0, 3).map((m) => m.name.split(' ')[0]).join(', ') + (detail.members.length > 3 ? ` +${detail.members.length - 3}` : '') : '';

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: th.bg }}>
      <Pressable onPress={() => router.push({ pathname: '/(main)/group/info/[id]', params: { id: id! } })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, backgroundColor: th.surface, borderBottomWidth: 0.5, borderBottomColor: th.border }}>
        <Pressable onPress={() => router.back()} hitSlop={12}><Text style={{ fontSize: 22, color: th.text }}>{locale === 'he' ? '›' : '‹'}</Text></Pressable>
        <Avatar name={detail?.context.name ?? '…'} size={38} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: '700', fontSize: 16, color: th.text }} numberOfLines={1}>
            {detail?.context.name} {detail?.context.displayId ? <Text style={{ color: th.textMuted, fontWeight: '400', fontSize: 13 }}>{detail.context.displayId}</Text> : null}
          </Text>
          <Muted>{memberLine}</Muted>
        </View>
      </Pressable>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          inverted
          data={messages}
          keyExtractor={(m) => m.id}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          contentContainerStyle={{ paddingVertical: 8 }}
          renderItem={({ item, index }) => {
            const prev = messages[index + 1];
            const showSender = !prev || prev.senderId !== item.senderId || item.createdAt - prev.createdAt > 10 * 60_000;
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(item.createdAt).toDateString();
            const reply = item.replyTo ? byId.get(item.replyTo) ?? null : null;
            return (
              <View>
                {newDay ? <Text style={{ alignSelf: 'center', marginVertical: 8, color: th.textMuted, fontSize: 12, backgroundColor: th.surface, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' }}>{formatDay(item.createdAt, locale, s)}</Text> : null}
                <MessageBubble
                  m={item}
                  mine={item.senderId === engine?.userId}
                  senderName={profiles.get(item.senderId)?.name ?? ''}
                  senderTitle={profiles.get(item.senderId)?.jobTitle ?? ''}
                  showSender={showSender}
                  receipt={receiptOf(item)}
                  replyTo={reply}
                  replySender={reply ? memberName(reply.senderId) : ''}
                  savedByName={memberName}
                  onLongPress={onLongPress}
                  onOpenFile={setViewer}
                  onRetry={() => void engine?.flushOutbox()}
                  myUserId={engine?.userId ?? ''}
                  memberNames={memberNames}
                />
              </View>
            );
          }}
        />
        {readOnly ? (
          <View style={{ padding: 14, backgroundColor: th.surface, alignItems: 'center', borderTopWidth: 0.5, borderTopColor: th.border }}>
            <Muted>{removed ? t('removedFromGroup') : detail?.context.archivedAt ? t('archivedGroup') : t('managedBy', { name: org?.org.name ?? '' })}</Muted>
          </View>
        ) : (
          <Composer
            members={members.filter((m) => detail?.members.some((d) => d.id === m.id) && m.id !== engine?.userId)}
            canSendFiles={!!org?.settings.permissions.sendFiles}
            replyTo={replyTo ? { m: replyTo, sender: memberName(replyTo.senderId) } : null}
            editing={editing}
            onCancelContext={() => { setReplyTo(null); setEditing(null); }}
            onSend={send}
            onEdit={async (m, text) => {
              setEditing(null);
              await engine?.edit(m, text).catch((e) => Alert.alert(t('error'), (e as ApiError).code));
            }}
          />
        )}
      </KeyboardAvoidingView>
      <MediaViewer file={viewer} onClose={() => setViewer(null)} />
      {saving ? <SaveToArchiveSheet message={saving.m} fileIds={saving.fileIds} onClose={() => setSaving(null)} onSaved={() => { setSaving(null); void reloadLocal(); }} /> : null}
    </SafeAreaView>
  );
}
