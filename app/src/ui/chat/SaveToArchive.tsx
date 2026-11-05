import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { api, ApiError } from '../../api/client';
import { encryptPayload } from '../../crypto/e2e';
import type { LocalMessage } from '../../db/local';
import { formatTime, formatDay, useI18n } from '../../i18n';
import { useSession } from '../../state/session';
import { Button, Chip, Field, Muted } from '../kit';
import { useTheme } from '../theme';

/**
 * "Save to the [label] file" (§4.3.3): document type (required), description (defaults to the caption),
 * document date (defaults to the send date). Several images can be saved in one action with one type.
 */
export function SaveToArchiveSheet({ message, fileIds, onClose, onSaved }: { message: LocalMessage | null; fileIds: string[]; onClose: () => void; onSaved: () => void }) {
  const { t, locale, s } = useI18n();
  const th = useTheme();
  const { org, engine, memberName } = useSession();
  const [docTypeId, setDocTypeId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const savable = (message?.payload?.files ?? []).filter((f) => !message?.archive.some((a) => a.fileId === f.id && !a.removedAt));

  useEffect(() => {
    if (!message) return;
    setDocTypeId(null);
    setDescription(message.payload?.text ?? '');
    setDate(new Date(message.createdAt).toISOString().slice(0, 10));
    setSelected(fileIds.length ? fileIds : savable.map((f) => f.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id]);

  if (!message || !org || !engine) return null;
  const label = org.contextType?.label ?? '';

  const save = async () => {
    if (!docTypeId || !selected.length) return;
    setBusy(true);
    try {
      let descriptionCt: string | undefined;
      let keyVersion: number | undefined;
      if (description.trim()) {
        const k = await engine.sendKey(message.groupId);
        descriptionCt = encryptPayload(k.key, message.groupId, k.version, { text: description.trim() });
        keyVersion = k.version;
      }
      await api.post(`/v1/groups/${message.groupId}/archive`, { messageId: message.id, fileIds: selected, docTypeId, docDate: date, descriptionCt, keyVersion });
      await engine.sync();
      onSaved();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'already_saved') {
        const ex = (err.data.existing as { savedBy: string; savedAt: number }[])[0];
        Alert.alert(t('alreadySaved', { name: memberName(ex.savedBy), time: `${formatDay(ex.savedAt, locale, s)} ${formatTime(ex.savedAt, locale)}` }));
      } else Alert.alert(t('error'), err.code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: th.overlay }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={{ backgroundColor: th.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 14, maxHeight: '85%' }}>
          <Text style={{ fontSize: 19, fontWeight: '700', color: th.text }}>{t('saveToArchive', { label })}</Text>
          <ScrollView contentContainerStyle={{ gap: 14 }} keyboardShouldPersistTaps="handled">
            {savable.length > 1 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {savable.map((f) => (
                  <Chip key={f.id} label={f.name} active={selected.includes(f.id)} onPress={() => setSelected((cur) => (cur.includes(f.id) ? cur.filter((x) => x !== f.id) : [...cur, f.id]))} />
                ))}
              </View>
            ) : null}
            <Text style={{ fontWeight: '600', color: th.text }}>{t('docType')} *</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {org.docTypes.map((d) => <Chip key={d.id} label={d.name} active={docTypeId === d.id} onPress={() => setDocTypeId(d.id)} />)}
            </View>
            <Field label={t('description')} value={description} onChangeText={setDescription} multiline />
            <Field label={t('docDate')} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
            {/* Plugin-provided fields (e.g. link to a visit) are added here in connected orgs (phase B). */}
            <Muted>{org.mode === 'standalone' ? '' : ''}</Muted>
          </ScrollView>
          <Button title={t('saveNFiles', { n: selected.length })} onPress={save} loading={busy} disabled={!docTypeId || !selected.length || !/^\d{4}-\d{2}-\d{2}$/.test(date)} />
          <Button title={t('cancel')} variant="ghost" onPress={onClose} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
