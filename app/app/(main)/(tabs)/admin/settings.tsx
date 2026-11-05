import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { api, ApiError } from '../../../../src/api/client';
import type { OrgSettings } from '../../../../src/api/types';
import { useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { Button, Chip, Divider, Field, Screen, Section, Title, ToggleRow } from '../../../../src/ui/kit';

/** Retention, organisation permissions, operating hours / do-not-disturb, auto-logout (§4.6). */
export default function Settings() {
  const { t, s } = useI18n();
  const { org, refreshOrg } = useSession();
  const [st, setSt] = useState<OrgSettings | null>(org?.settings ?? null);
  const [busy, setBusy] = useState(false);
  if (!st) return null;
  const perm = (k: keyof OrgSettings['permissions'], v: boolean | string) => setSt({ ...st, permissions: { ...st.permissions, [k]: v } });
  const hours = (patch: Partial<OrgSettings['operatingHours']>) => setSt({ ...st, operatingHours: { ...st.operatingHours, ...patch } });

  return (
    <Screen scroll>
      <Title>{t('policySecurity')}</Title>
      <Section title={t('retention')}>
        <View style={{ padding: 12 }}>
          <Field keyboardType="number-pad" value={String(st.retentionMonths)} onChangeText={(v) => setSt({ ...st, retentionMonths: Number(v.replace(/\D/g, '')) || 0 })} hint={t('months')} />
        </View>
      </Section>
      <Section title={t('autoLogout')}>
        <View style={{ padding: 12 }}>
          <Field keyboardType="number-pad" value={String(st.autoLogoutMinutes)} onChangeText={(v) => setSt({ ...st, autoLogoutMinutes: Number(v.replace(/\D/g, '')) || 0 })} hint={t('minutes')} />
        </View>
      </Section>
      <Section title={t('permissions')}>
        <ToggleRow title={t('permUsersCreateContexts')} value={st.permissions.usersCreateContexts} onChange={(v) => perm('usersCreateContexts', v)} />
        <Divider />
        <ToggleRow title={t('permMembersAddMembers')} value={st.permissions.membersAddMembers} onChange={(v) => perm('membersAddMembers', v)} />
        <Divider />
        <ToggleRow title={t('permSendFiles')} value={st.permissions.sendFiles} onChange={(v) => perm('sendFiles', v)} />
        <Divider />
        <ToggleRow title={t('permDownload')} value={st.permissions.downloadAndShare} onChange={(v) => perm('downloadAndShare', v)} />
        <Divider />
        <ToggleRow title={t('permDelete')} value={st.permissions.deleteMessages} onChange={(v) => perm('deleteMessages', v)} />
        <Divider />
        <ToggleRow title={t('permArchiveAdmins')} value={st.permissions.archiveSave === 'admins'} onChange={(v) => perm('archiveSave', v ? 'admins' : 'all')} />
      </Section>
      <Section title={t('operatingHours')}>
        <ToggleRow title={t('quietHours')} value={st.operatingHours.enabled} onChange={(v) => hours({ enabled: v })} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 12 }}>
          {s.days.map((d, i) => (
            <Chip key={i} label={d} active={st.operatingHours.days.includes(i)} onPress={() => hours({ days: st.operatingHours.days.includes(i) ? st.operatingHours.days.filter((x) => x !== i) : [...st.operatingHours.days, i].sort() })} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: 8, padding: 12, paddingTop: 0 }}>
          <View style={{ flex: 1 }}><Field label={t('from')} value={st.operatingHours.start} onChangeText={(v) => hours({ start: v })} placeholder="08:00" /></View>
          <View style={{ flex: 1 }}><Field label={t('to')} value={st.operatingHours.end} onChangeText={(v) => hours({ end: v })} placeholder="20:00" /></View>
        </View>
      </Section>
      <Button title={t('save')} loading={busy} onPress={async () => {
        setBusy(true);
        try {
          await api.put('/v1/admin/settings', st);
          await refreshOrg();
          Alert.alert('✓');
        } catch (e) {
          const err = e as ApiError;
          Alert.alert(t('error'), String(err.data.field ?? err.code));
        } finally {
          setBusy(false);
        }
      }} />
    </Screen>
  );
}
