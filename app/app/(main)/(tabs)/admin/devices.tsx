import React from 'react';
import { Alert } from 'react-native';
import { api } from '../../../../src/api/client';
import { formatDay, useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { useAsync } from '../../../../src/ui/useAsync';
import { Divider, Muted, Row, Screen, Section, Title } from '../../../../src/ui/kit';

/** Active devices per user, with remote disconnect (wipes only this org's data on that device). */
export default function Devices() {
  const { t, locale, s } = useI18n();
  const { deviceId } = useSession();
  const { data, reload } = useAsync(() => api.get<{ devices: { id: string; userName: string; platform: string; name: string; lastSeenAt: number }[] }>('/v1/admin/devices'), []);
  return (
    <Screen scroll>
      <Title>{t('devices')}</Title>
      <Section>
        {(data?.devices ?? []).map((d, i) => (
          <React.Fragment key={d.id}>
            {i ? <Divider /> : null}
            <Row
              title={`${d.userName}${d.id === deviceId ? ' ★' : ''}`}
              subtitle={`${d.name || d.platform} · ${formatDay(d.lastSeenAt, locale, s)}`}
              right={<Muted>{d.platform}</Muted>}
              onPress={() => Alert.alert(t('disconnectDevice'), `${d.userName} · ${d.name || d.platform}`, [
                { text: t('cancel'), style: 'cancel' },
                { text: t('disconnectDevice'), style: 'destructive', onPress: async () => { await api.post(`/v1/admin/devices/${d.id}/revoke`); await reload(); } },
              ])}
            />
          </React.Fragment>
        ))}
      </Section>
    </Screen>
  );
}
