import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import * as Sharing from 'expo-sharing';
import Pdf from 'react-native-pdf';
import type { MessagePayload } from '../../crypto/e2e';
import { dataUri, loadMedia, withTempPlainFile } from '../../media/files';
import { useSession } from '../../state/session';
import { useI18n } from '../../i18n';
import { useTheme } from '../theme';

export type FileMeta = NonNullable<MessagePayload['files']>[number];

/** Thumbnail in the chat: only the ~15KB thumb variant is fetched (§7.7). */
export function Thumb({ file, size, onPress, onLongPress }: { file: FileMeta; size: number; onPress: () => void; onLongPress: () => void }) {
  const { engine, org } = useSession();
  const th = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (engine) {
      loadMedia(engine.db, file, 'thumb', org?.settings.mediaCacheMb)
        .then((b) => alive && setUri(dataUri(b, 'image/webp')))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [engine, file, org?.settings.mediaCacheMb]);
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350}>
      <View style={{ width: size, height: size, borderRadius: 10, overflow: 'hidden', backgroundColor: th.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
        {uri ? <Image source={{ uri }} style={{ width: size, height: size }} blurRadius={0} /> : <ActivityIndicator />}
      </View>
    </Pressable>
  );
}

/** Full-screen viewer: preview variant first, original on demand for zoom (§4.3.2). PDFs render in-app. */
export function MediaViewer({ file, onClose }: { file: FileMeta | null; onClose: () => void }) {
  const { engine, org } = useSession();
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const [uri, setUri] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [original, setOriginal] = useState(false);
  const isImage = file?.mime.startsWith('image/') ?? false;
  const isPdf = file?.mime === 'application/pdf';

  useEffect(() => {
    setUri(null);
    setBytes(null);
    setOriginal(false);
    if (!file || !engine) return;
    const variant = isImage ? 'preview' : 'original';
    loadMedia(engine.db, file, variant, org?.settings.mediaCacheMb)
      .then((b) => {
        setBytes(b);
        setUri(dataUri(b, isImage ? 'image/jpeg' : file.mime));
      })
      .catch(() => setUri(null));
  }, [file, engine, isImage, org?.settings.mediaCacheMb]);

  const loadOriginal = async () => {
    if (!file || !engine) return;
    const b = await loadMedia(engine.db, file, 'original');
    setBytes(b);
    setUri(dataUri(b, 'image/jpeg'));
    setOriginal(true);
  };

  const share = async () => {
    if (!file || !engine) return;
    const b = bytes && (original || !isImage) ? bytes : await loadMedia(engine.db, file, 'original');
    await withTempPlainFile(file.name, b, (u) => Sharing.shareAsync(u, { mimeType: file.mime }));
  };

  return (
    <Modal visible={!!file} animationType="fade" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 12 }}>
          <Pressable onPress={onClose}><Text style={{ color: '#fff', fontSize: 16 }}>{t('close')}</Text></Pressable>
          <Text style={{ color: '#fff', flex: 1, textAlign: 'center' }} numberOfLines={1}>{file?.name}</Text>
          {org?.settings.permissions.downloadAndShare ? <Pressable onPress={share}><Text style={{ color: '#fff', fontSize: 16 }}>{t('share')}</Text></Pressable> : <View style={{ width: 40 }} />}
        </View>
        {!uri ? (
          <ActivityIndicator color="#fff" style={{ flex: 1 }} />
        ) : isImage ? (
          <ScrollView maximumZoomScale={5} minimumZoomScale={1} centerContent contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }} onScrollEndDrag={() => !original && void loadOriginal()}>
            <Image source={{ uri }} style={{ width, height: height - 140 }} resizeMode="contain" />
          </ScrollView>
        ) : isPdf ? (
          <Pdf source={{ uri }} style={{ flex: 1, width, backgroundColor: '#222' }} trustAllCerts={false} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Text style={{ fontSize: 48 }}>📄</Text>
            <Text style={{ color: '#fff' }}>{file?.name}</Text>
            <Text style={{ color: '#aaa' }}>{file ? formatSize(file.size) : ''}</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function fileTypeLabel(mime: string, name: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (/word/.test(mime) || /\.docx?$/i.test(name)) return 'Word';
  if (/sheet|excel/.test(mime) || /\.xlsx?$/i.test(name)) return 'Excel';
  if (mime.startsWith('image/')) return 'Image';
  return name.split('.').pop()?.toUpperCase() ?? 'File';
}
