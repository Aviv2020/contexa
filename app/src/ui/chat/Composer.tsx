import React, { useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import type { OrgMember } from '../../api/types';
import type { LocalMessage } from '../../db/local';
import { MAX_FILE_BYTES, MAX_IMAGES_PER_SEND } from '../../config';
import { useI18n } from '../../i18n';
import { useTheme } from '../theme';

export interface PickedAsset {
  uri: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'document';
}

const DOC_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/*',
];

export function Composer(props: {
  members: OrgMember[];
  canSendFiles: boolean;
  replyTo: { m: LocalMessage; sender: string } | null;
  editing: LocalMessage | null;
  onCancelContext: () => void;
  onSend: (text: string, mentions: string[], assets: PickedAsset[], originalQuality: boolean) => void;
  onEdit: (m: LocalMessage, text: string) => void;
}) {
  const { t } = useI18n();
  const th = useTheme();
  const [text, setText] = useState(props.editing?.payload?.text ?? '');
  const [mentions, setMentions] = useState<string[]>([]);
  const [assets, setAssets] = useState<PickedAsset[]>([]);
  const [originalQuality, setOriginalQuality] = useState(false);

  React.useEffect(() => {
    if (props.editing) setText(props.editing.payload?.text ?? '');
  }, [props.editing]);

  const mentionQuery = useMemo(() => {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(text);
    return m ? m[1] : null;
  }, [text]);
  const suggestions = mentionQuery === null ? [] : props.members.filter((m) => m.name.includes(mentionQuery)).slice(0, 5);

  const pickMention = (m: OrgMember) => {
    setText((cur) => cur.replace(/@([^\s@]*)$/, `@${m.name} `));
    setMentions((cur) => [...new Set([...cur, m.id])]);
  };

  const addAssets = (list: PickedAsset[]) => {
    const tooBig = list.find((a) => a.size > MAX_FILE_BYTES);
    if (tooBig) Alert.alert(t('fileTooLarge'));
    const ok = list.filter((a) => a.size <= MAX_FILE_BYTES);
    const next = [...assets, ...ok];
    if (next.filter((a) => a.kind === 'image').length > MAX_IMAGES_PER_SEND) {
      Alert.alert(t('tooManyImages'));
      return;
    }
    setAssets(next);
  };

  const attach = () => {
    const opts = [t('camera'), t('gallery'), t('document'), t('cancel')];
    const run = async (i: number) => {
      if (i === 0) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return;
        // In-app capture: the photo stays in the app sandbox and is not written to the device gallery (§4.3.2).
        const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false });
        if (!r.canceled) addAssets(r.assets.map((a) => ({ uri: a.uri, name: a.fileName ?? `IMG_${Date.now()}.jpg`, mime: 'image/jpeg', size: a.fileSize ?? 0, kind: 'image' as const })));
      } else if (i === 1) {
        const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: MAX_IMAGES_PER_SEND, quality: 1, exif: false });
        if (!r.canceled) addAssets(r.assets.map((a) => ({ uri: a.uri, name: a.fileName ?? `IMG_${Date.now()}.jpg`, mime: a.mimeType ?? 'image/jpeg', size: a.fileSize ?? 0, kind: 'image' as const })));
      } else if (i === 2) {
        const r = await DocumentPicker.getDocumentAsync({ type: DOC_TYPES, copyToCacheDirectory: true, multiple: false });
        if (!r.canceled) addAssets(r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? 'application/octet-stream', size: a.size ?? 0, kind: a.mimeType?.startsWith('image/') ? ('image' as const) : ('document' as const) })));
      }
    };
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: opts, cancelButtonIndex: 3 }, run);
    else Alert.alert(t('document'), undefined, opts.map((o, i) => ({ text: o, onPress: () => run(i), style: i === 3 ? 'cancel' : 'default' })));
  };

  const submit = () => {
    const body = text.trim();
    if (props.editing) {
      if (body) props.onEdit(props.editing, body);
    } else if (body || assets.length) {
      props.onSend(body, mentions.filter((id) => body.includes(`@${props.members.find((m) => m.id === id)?.name}`)), assets, originalQuality);
    }
    setText('');
    setMentions([]);
    setAssets([]);
    setOriginalQuality(false);
  };

  return (
    <View style={{ backgroundColor: th.surface, borderTopWidth: 0.5, borderTopColor: th.border, paddingBottom: 6 }}>
      {suggestions.length ? (
        <View style={{ borderBottomWidth: 0.5, borderBottomColor: th.border }}>
          {suggestions.map((m) => (
            <Pressable key={m.id} onPress={() => pickMention(m)} style={{ padding: 10, paddingHorizontal: 16 }}>
              <Text style={{ color: th.text }}>@{m.name} <Text style={{ color: th.textMuted }}>{m.jobTitle}</Text></Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {props.replyTo || props.editing ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, paddingHorizontal: 14, gap: 8, backgroundColor: th.surfaceAlt }}>
          <View style={{ flex: 1, borderStartWidth: 3, borderStartColor: th.accent, paddingStart: 8 }}>
            <Text style={{ color: th.accent, fontWeight: '700', fontSize: 12 }}>{props.editing ? t('edit') : `${t('reply')} · ${props.replyTo!.sender}`}</Text>
            <Text style={{ color: th.textMuted, fontSize: 13 }} numberOfLines={1}>{(props.editing ?? props.replyTo!.m).payload?.text ?? (props.editing ?? props.replyTo!.m).payload?.files?.[0]?.name}</Text>
          </View>
          <Pressable onPress={() => { props.onCancelContext(); setText(''); }}><Text style={{ fontSize: 18, color: th.textMuted }}>✕</Text></Pressable>
        </View>
      ) : null}
      {assets.length ? (
        <View style={{ padding: 8, paddingHorizontal: 14, gap: 6 }}>
          <Text style={{ color: th.text }} numberOfLines={2}>📎 {assets.map((a) => a.name).join(', ')}</Text>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            {assets.some((a) => a.kind === 'image') ? (
              <Pressable onPress={() => setOriginalQuality((v) => !v)}><Text style={{ color: originalQuality ? th.accent : th.textMuted }}>{originalQuality ? '☑' : '☐'} {t('originalQuality')}</Text></Pressable>
            ) : null}
            <Pressable onPress={() => setAssets([])}><Text style={{ color: th.danger }}>{t('cancel')}</Text></Pressable>
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8 }}>
        {props.canSendFiles && !props.editing ? (
          <Pressable onPress={attach} accessibilityLabel={t('document')} style={{ padding: 8 }}><Text style={{ fontSize: 22 }}>📎</Text></Pressable>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={assets.length ? t('caption') : t('messagePlaceholder')}
          placeholderTextColor={th.textMuted}
          multiline
          style={{ flex: 1, maxHeight: 120, minHeight: 40, backgroundColor: th.bg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, fontSize: 16, color: th.text, textAlign: 'auto' }}
        />
        <Pressable onPress={submit} accessibilityLabel={t('send')} disabled={!text.trim() && !assets.length} style={{ backgroundColor: th.brand, width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', opacity: text.trim() || assets.length ? 1 : 0.4 }}>
          <Text style={{ color: '#fff', fontSize: 18 }}>{props.editing ? '✓' : '➤'}</Text>
        </Pressable>
      </View>
    </View>
  );
}
