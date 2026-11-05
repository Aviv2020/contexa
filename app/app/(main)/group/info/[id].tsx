import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api, ApiError } from '../../../../src/api/client';
import type { GroupDetail } from '../../../../src/api/types';
import { useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { Avatar, Button, Divider, Muted, Row, Screen, Section, ToggleRow } from '../../../../src/ui/kit';
import { useTheme } from '../../../../src/ui/theme';

/** Group header (§4.2.3): context fields, archive, members with job titles, membership management. */
export default function GroupInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const th = useTheme();
  const { org, members, engine } = useSession();
  const [d, setD] = useState<GroupDetail | null>(null);
  const [picking, setPicking] = useState(false);
  const load = useCallback(async () => setD(await api.get<GroupDetail>(`/v1/groups/${id}`)), [id]);
  useEffect(() => void load().catch(() => undefined), [load]);
  if (!d || !org) return <Screen><Muted>{t('loading')}</Muted></Screen>;

  const label = org.contextType?.label ?? '';
  const fields = org.contextType?.headerFields ?? [];
  const muted = d.me.mutedUntil === -1 || d.me.mutedUntil > Date.now();
  const isAdmin = org.role === 'admin';
  const candidates = members.filter((m) => !d.members.some((x) => x.id === m.id));

  const setState = async (body: object) => {
    await api.put(`/v1/groups/${id}/state`, body);
    await load();
  };

  return (
    <Screen scroll>
      <View style={{ alignItems: 'center', gap: 8 }}>
        <Avatar name={d.context.name} size={84} />
        <Text style={{ fontSize: 22, fontWeight: '700', color: th.text }}>{d.context.name}</Text>
        <Muted>{[t('groupOf', { label }), d.context.displayId].filter(Boolean).join(' · ')}</Muted>
      </View>
      {fields.length ? (
        <Section>
          {fields.map((f, i) => (
            <React.Fragment key={f.key}>
              {i ? <Divider /> : null}
              <Row title={d.context.header[f.key] || '—'} subtitle={f.label} />
            </React.Fragment>
          ))}
        </Section>
      ) : null}
      <Section>
        <Row title={`📁 ${t('archive')}`} right={<Muted>{String(d.archiveCount)}</Muted>} onPress={() => router.push({ pathname: '/(main)/group/archive/[id]', params: { id: d.context.id, groupId: d.id } })} />
        <Divider />
        <ToggleRow title={t('pin')} value={d.me.pinned} onChange={(v) => setState({ pinned: v })} />
        <Divider />
        <Row
          title={muted ? t('unmute') : t('mute')}
          onPress={() => {
            if (muted) return void setState({ mutedUntil: 0 });
            const tomorrow = new Date();
            tomorrow.setHours(24 + 8, 0, 0, 0);
            Alert.alert(t('mute'), undefined, [
              { text: t('muteHour'), onPress: () => setState({ mutedUntil: Date.now() + 3600_000 }) },
              { text: t('muteTomorrow'), onPress: () => setState({ mutedUntil: tomorrow.getTime() }) },
              { text: t('muteForever'), onPress: () => setState({ mutedUntil: -1 }) },
              { text: t('cancel'), style: 'cancel' },
            ]);
          }}
        />
      </Section>
      <Section title={`${t('members')} (${d.members.length})`}>
        {d.membersManagedBy ? <Row title={t('managedBy', { name: d.membersManagedBy })} /> : null}
        {d.members.map((m, i) => (
          <React.Fragment key={m.id}>
            {i ? <Divider /> : null}
            <Row
              title={m.name}
              subtitle={[m.jobTitle, m.role === 'admin' ? t('roleAdmin') : ''].filter(Boolean).join(' · ')}
              left={<Avatar name={m.name} size={36} />}
              onPress={isAdmin && !d.membersManagedBy && m.id !== engine?.userId ? () => Alert.alert(m.name, undefined, [
                { text: t('removeMember'), style: 'destructive', onPress: async () => { await api.del(`/v1/groups/${id}/members/${m.id}`); await load(); } },
                { text: t('cancel'), style: 'cancel' },
              ]) : undefined}
            />
          </React.Fragment>
        ))}
        {d.canAddMembers ? (<><Divider /><Row title={`＋ ${t('addMember')}`} onPress={() => setPicking(true)} /></>) : null}
      </Section>
      {isAdmin && org.mode === 'standalone' ? (
        <Button
          variant="secondary"
          title={d.context.archivedAt ? t('reactivate') : t('filterArchived')}
          onPress={async () => {
            await api.patch(`/v1/contexts/${d.context.id}`, { archived: !d.context.archivedAt });
            await load();
          }}
        />
      ) : null}
      <Modal visible={picking} animationType="slide" onRequestClose={() => setPicking(false)} presentationStyle="pageSheet">
        <Screen scroll>
          <Text style={{ fontSize: 20, fontWeight: '700', color: th.text }}>{t('addMember')}</Text>
          <Section>
            {candidates.map((m, i) => (
              <React.Fragment key={m.id}>
                {i ? <Divider /> : null}
                <Row title={m.name} subtitle={m.jobTitle} left={<Avatar name={m.name} size={36} />} onPress={async () => {
                  try {
                    await api.post(`/v1/groups/${id}/members`, { userIds: [m.id] });
                    setPicking(false);
                    await load();
                  } catch (e) {
                    Alert.alert(t('error'), (e as ApiError).code);
                  }
                }} />
              </React.Fragment>
            ))}
          </Section>
          <Button variant="ghost" title={t('close')} onPress={() => setPicking(false)} />
        </Screen>
      </Modal>
    </Screen>
  );
}
