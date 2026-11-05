import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { LocalMessage } from '../../db/local';
import { formatTime, useI18n } from '../../i18n';
import { useTheme, radius } from '../theme';
import { Thumb, fileTypeLabel, formatSize, type FileMeta } from './Media';

export interface BubbleProps {
  m: LocalMessage;
  mine: boolean;
  senderName: string;
  senderTitle: string;
  showSender: boolean;
  receipt: 'none' | 'sent' | 'delivered' | 'read';
  replyTo: LocalMessage | null;
  replySender: string;
  savedByName: (id: string) => string;
  onLongPress: (m: LocalMessage, file?: FileMeta) => void;
  onOpenFile: (f: FileMeta) => void;
  onRetry: (m: LocalMessage) => void;
  myUserId: string;
  memberNames: Record<string, string>;
}

function renderText(text: string, mentionNames: string[], color: string, accent: string) {
  if (!mentionNames.length) return <Text style={{ color, fontSize: 16, lineHeight: 22 }}>{text}</Text>;
  const parts = text.split(new RegExp(`(@(?:${mentionNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'g'));
  return (
    <Text style={{ color, fontSize: 16, lineHeight: 22 }}>
      {parts.map((p, i) => (p.startsWith('@') && mentionNames.includes(p.slice(1)) ? <Text key={i} style={{ color: accent, fontWeight: '600' }}>{p}</Text> : p))}
    </Text>
  );
}

export function MessageBubble(p: BubbleProps) {
  const th = useTheme();
  const { t, locale } = useI18n();
  const { m } = p;
  const files = m.payload?.files ?? [];
  const images = files.filter((f) => f.mime.startsWith('image/'));
  const docs = files.filter((f) => !f.mime.startsWith('image/'));
  const archiveByFile = new Map(m.archive.filter((a) => !a.removedAt).map((a) => [a.fileId, a]));
  const anySaved = m.archive.find((a) => !a.removedAt);
  const mentionNames = m.mentions.map((id) => p.memberNames[id]).filter(Boolean);

  const tick = m.status === 'pending' ? '🕓' : m.status === 'failed' ? '⚠️' : p.receipt === 'read' ? '✓✓' : p.receipt === 'delivered' ? '✓✓' : '✓';
  const tickColor = p.receipt === 'read' ? th.accent : th.textMuted;

  return (
    <View style={{ alignItems: p.mine ? 'flex-end' : 'flex-start', paddingHorizontal: 10, marginTop: p.showSender ? 8 : 2 }}>
      <Pressable
        onLongPress={() => p.onLongPress(m)}
        delayLongPress={350}
        onPress={m.status === 'failed' ? () => p.onRetry(m) : undefined}
        style={{ maxWidth: '84%', backgroundColor: p.mine ? th.bubbleMine : th.bubbleOther, borderRadius: radius.lg, padding: 8, paddingHorizontal: 11, gap: 4, borderWidth: p.mine ? 0 : 0.5, borderColor: th.border }}
      >
        {p.showSender && !p.mine ? (
          <Text style={{ fontSize: 13, fontWeight: '700', color: th.accent }}>
            {p.senderName}
            {p.senderTitle ? <Text style={{ fontWeight: '400', color: th.textMuted }}> · {p.senderTitle}</Text> : null}
          </Text>
        ) : null}
        {p.replyTo ? (
          <View style={{ borderStartWidth: 3, borderStartColor: th.accent, backgroundColor: th.surfaceAlt, borderRadius: 6, padding: 6 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: th.accent }}>{p.replySender}</Text>
            <Text style={{ fontSize: 13, color: th.textMuted }} numberOfLines={2}>{p.replyTo.payload?.text ?? p.replyTo.payload?.files?.[0]?.name ?? t('messageDeleted')}</Text>
          </View>
        ) : null}

        {m.deletedAt ? (
          <Text style={{ fontStyle: 'italic', color: th.textMuted }}>🚫 {t('messageDeleted')}</Text>
        ) : m.status === 'undecryptable' ? (
          <Text style={{ fontStyle: 'italic', color: th.textMuted }}>🔒 {t('historyUnlocking')}</Text>
        ) : (
          <>
            {images.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, width: images.length > 1 ? 244 : 240 }}>
                {images.map((f) => (
                  <View key={f.id}>
                    <Thumb file={f} size={images.length > 1 ? 120 : 240} onPress={() => p.onOpenFile(f)} onLongPress={() => p.onLongPress(m, f)} />
                    {archiveByFile.has(f.id) ? <Text style={{ position: 'absolute', top: 4, end: 4, fontSize: 14 }}>📁</Text> : null}
                  </View>
                ))}
              </View>
            ) : null}
            {docs.map((f) => (
              <Pressable key={f.id} onPress={() => p.onOpenFile(f)} onLongPress={() => p.onLongPress(m, f)} delayLongPress={350} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: th.surfaceAlt, borderRadius: 10, padding: 10, minWidth: 220 }}>
                <Text style={{ fontSize: 28 }}>📄</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: th.text, fontWeight: '600' }} numberOfLines={1}>{f.name}</Text>
                  <Text style={{ color: th.textMuted, fontSize: 12 }}>{fileTypeLabel(f.mime, f.name)} · {formatSize(f.size)}</Text>
                  {!archiveByFile.has(f.id) ? <Text style={{ color: th.textMuted, fontSize: 11 }}>{t('longPressToSave')}</Text> : null}
                </View>
              </Pressable>
            ))}
            {m.payload?.text ? renderText(m.payload.text, mentionNames, th.text, th.accent) : null}
          </>
        )}

        {anySaved ? (
          <Text style={{ fontSize: 12, color: th.accent, fontWeight: '600' }}>
            ✓ {anySaved.status === 'pending' ? t('savePending') : t('savedToArchive', { name: p.savedByName(anySaved.savedBy), time: formatTime(anySaved.savedAt, locale) })}
            {anySaved.docTypeName ? ` · ${anySaved.docTypeName}` : ''}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', alignSelf: 'flex-end', gap: 4, alignItems: 'center' }}>
          {m.editedAt && !m.deletedAt ? <Text style={{ fontSize: 11, color: th.textMuted }}>{t('edited')}</Text> : null}
          <Text style={{ fontSize: 11, color: th.textMuted }}>{formatTime(m.createdAt, locale)}</Text>
          {p.mine ? <Text style={{ fontSize: 11, color: tickColor }}>{tick}</Text> : null}
        </View>
      </Pressable>
    </View>
  );
}
