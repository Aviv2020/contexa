import React from 'react';
import { router, type Href } from 'expo-router';
import { useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { api } from '../../../../src/api/client';
import { useAsync } from '../../../../src/ui/useAsync';
import { Divider, Muted, Row, Screen, Section, Title } from '../../../../src/ui/kit';

/** Admin home (§4.6). Every setting lives in the app; nothing is configured on the web. */
export default function AdminHome() {
  const { t, s } = useI18n();
  const { org } = useSession();
  const { data: users } = useAsync(() => api.get<{ users: { status: string }[] }>('/v1/admin/users'), [org?.org.id]);
  const { data: devices } = useAsync(() => api.get<{ devices: unknown[] }>('/v1/admin/devices'), [org?.org.id]);
  if (!org) return null;
  const st = org.settings;
  const hours = st.operatingHours.enabled ? `${st.operatingHours.days.map((d) => s.days[d]).join(' ')} ${st.operatingHours.start}–${st.operatingHours.end}` : '—';
  const go = (p: string) => () => router.push(`/(main)/(tabs)/admin/${p}` as Href);
  return (
    <Screen scroll edges={['top']}>
      <Title sub={org.org.name}>{t('adminTitle')}</Title>
      <Section title={t('adminOrg')}>
        <Row title={t('users')} right={<Muted>{String(users?.users.filter((u) => u.status !== 'deactivated').length ?? '')}</Muted>} onPress={go('users')} />
        <Divider />
        <Row title={t('contextType')} right={<Muted>{org.contextType?.label ?? ''}</Muted>} onPress={go('context-type')} />
        <Divider />
        <Row title={t('contexts')} right={<Muted>{org.contextType?.labelPlural ?? ''}</Muted>} onPress={go('contexts')} />
        <Divider />
        <Row title={t('docTypes')} right={<Muted>{String(org.docTypes.length)}</Muted>} onPress={go('doc-types')} />
        <Divider />
        <Row title={t('operatingHours')} right={<Muted>{hours}</Muted>} onPress={go('settings')} />
      </Section>
      <Section title={t('policySecurity')}>
        <Row title={t('retention')} right={<Muted>{`${st.retentionMonths} ${t('months')}`}</Muted>} onPress={go('settings')} />
        <Divider />
        <Row title={t('permissions')} onPress={go('settings')} />
        <Divider />
        <Row title={t('autoLogout')} right={<Muted>{`${st.autoLogoutMinutes} ${t('minutes')}`}</Muted>} onPress={go('settings')} />
      </Section>
      <Section title={t('plugins')}>
        <Row title={t('plugins')} subtitle={t('pluginsEmpty')} />
      </Section>
      <Section title={t('control')}>
        <Row title={t('auditLog')} onPress={go('audit')} />
        <Divider />
        <Row title={t('devices')} right={<Muted>{String(devices?.devices.length ?? '')}</Muted>} onPress={go('devices')} />
      </Section>
    </Screen>
  );
}
