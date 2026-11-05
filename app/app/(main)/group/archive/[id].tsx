import React, { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '../../../../src/api/client';
import { decryptPayload, type MessagePayload } from '../../../../src/crypto/e2e';
import { formatDay, useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { MediaViewer, type FileMeta } from '../../../../src/ui/chat/Media';
import { Chip, Field, Muted, Screen, Title } from '../../../../src/ui/kit';
import { useTheme } from '../../../../src/ui/theme';

interface Doc {
  id: string;
  fileId: string;
  messageId: string;
  docTypeId: string;
  docTypeName: string;
  descriptionCt: string | null;
  keyVersion: number | null;
  docDate: string;
  savedBy: string;
  savedAt: number;
  kind: string;
  size: number;
  messageCiphertext: string | null;
  messageKeyVersion: number;
}

/** Context archive (standalone): filterable by document type and date range (§4.3.3). Files stay encrypted. */
export default function Archive() {
  const { id, groupId } = useLocalSearchParams<{ id: string; groupId: string }>();
  const { t, locale, s } = useI18n();
  const th = useTheme();
  const { org, engine, memberName } = useSession();
  const [docs, setDocs] = useState<(Doc & { description: string; file: FileMeta | null })[]>([]);
  const [type, setType] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [viewer, setViewer] = useState<FileMeta | null>(null);

  const load = async () => {
    const qs = new URLSearchParams({ ...(type ? { docTypeId: type } : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test(from) ? { from } : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test(to) ? { to } : {}) });
    const r = await api.get<{ documents: Doc[] }>(`/v1/contexts/${id}/archive?${qs}`);
    const out = [];
    for (const d of r.documents) {
      let description = '';
      let file: FileMeta | null = null;
      try {
        if (d.descriptionCt && d.keyVersion && engine) {
          const k = await engine.groupKey(groupId!, d.keyVersion);
          if (k) description = decryptPayload<MessagePayload>(k, groupId!, d.keyVersion, d.descriptionCt).text ?? '';
        }
        // The file key lives in the original message. If the chat message was deleted, the local copy still has it.
        const local = await engine?.db.message(d.messageId);
        const payload = local?.payload ?? (d.messageCiphertext && engine ? await decryptMsg(d) : null);
        file = payload?.files?.find((f) => f.id === d.fileId) ?? null;
      } catch {
        /* not decryptable on this device */
      }
      out.push({ ...d, description, file });
    }
    setDocs(out);
  };

  const decryptMsg = async (d: Doc) => {
    const k = await engine!.groupKey(groupId!, d.messageKeyVersion);
    return k ? decryptPayload<MessagePayload>(k, groupId!, d.messageKeyVersion, d.messageCiphertext!) : null;
  };

  useEffect(() => void load().catch(() => undefined), [type, from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Screen>
      <View style={{ padding: 16, gap: 10 }}>
        <Title>{t('archive')} · {org?.contextType?.label}</Title>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip label={t('allTypes')} active={!type} onPress={() => setType(null)} />
          {org?.docTypes.map((d) => <Chip key={d.id} label={d.name} active={type === d.id} onPress={() => setType(d.id)} />)}
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><Field placeholder={`${t('from')} YYYY-MM-DD`} value={from} onChangeText={setFrom} /></View>
          <View style={{ flex: 1 }}><Field placeholder={`${t('to')} YYYY-MM-DD`} value={to} onChangeText={setTo} /></View>
        </View>
      </View>
      <FlatList
        data={docs}
        keyExtractor={(d) => d.id}
        ListEmptyComponent={<Muted style={{ textAlign: 'center', marginTop: 40 }}>{t('archiveEmpty')}</Muted>}
        renderItem={({ item: d }) => (
          <Pressable
            onPress={() => d.file && setViewer(d.file)}
            onLongPress={org?.role === 'admin' && org.mode === 'standalone' ? () => Alert.alert(t('removeFromArchive'), t('areYouSure'), [
              { text: t('cancel'), style: 'cancel' },
              { text: t('delete'), style: 'destructive', onPress: async () => { await api.del(`/v1/archive/${d.id}`); await load(); } },
            ]) : undefined}
            style={{ flexDirection: 'row', gap: 12, padding: 14, paddingHorizontal: 16, borderBottomWidth: 0.5, borderBottomColor: th.border, backgroundColor: th.surface }}
          >
            <Text style={{ fontSize: 26 }}>{d.kind === 'image' ? '🖼️' : '📄'}</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontWeight: '600', color: th.text }}>{d.docTypeName} · {d.docDate}</Text>
              {d.description ? <Text style={{ color: th.text }} numberOfLines={2}>{d.description}</Text> : null}
              <Muted>{d.file?.name ?? '🔒'} · {memberName(d.savedBy)} · {formatDay(d.savedAt, locale, s)}</Muted>
            </View>
          </Pressable>
        )}
      />
      <MediaViewer file={viewer} onClose={() => setViewer(null)} />
    </Screen>
  );
}
