import React, { useState } from 'react';
import { Alert, Modal, View } from 'react-native';
import { api, ApiError } from '../../../../src/api/client';
import { useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { useAsync } from '../../../../src/ui/useAsync';
import { Avatar, Button, Chip, Divider, ErrorText, Field, Muted, Row, Screen, Section, Title } from '../../../../src/ui/kit';

interface AdminUser {
  id: string;
  phone: string;
  name: string;
  role: 'admin' | 'user';
  jobTitle: string;
  status: 'invited' | 'active' | 'deactivated';
  managedBy: string | null;
}

export default function Users() {
  const { t } = useI18n();
  const { org, refreshOrg } = useSession();
  const { data, reload } = useAsync(() => api.get<{ users: AdminUser[] }>('/v1/admin/users'), []);
  const [editing, setEditing] = useState<Partial<AdminUser> | null>(null);
  const [error, setError] = useState('');
  const locked = org?.mode === 'connected';

  const statusLabel = (s: AdminUser['status']) => (s === 'active' ? t('statusActive') : s === 'invited' ? t('statusInvited') : t('statusDeactivated'));

  const save = async () => {
    if (!editing) return;
    setError('');
    try {
      if (editing.id) await api.patch(`/v1/admin/users/${editing.id}`, { role: editing.role, jobTitle: editing.jobTitle, name: editing.name });
      else await api.post('/v1/admin/users', { phone: editing.phone, name: editing.name, role: editing.role ?? 'user', jobTitle: editing.jobTitle });
      setEditing(null);
      await reload();
      await refreshOrg();
    } catch (e) {
      setError((e as ApiError).code);
    }
  };

  const toggleActive = (u: AdminUser) => {
    const deactivate = u.status !== 'deactivated';
    Alert.alert(u.name, t('areYouSure'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: deactivate ? t('deactivate') : t('reactivate'),
        style: deactivate ? 'destructive' : 'default',
        onPress: async () => {
          try {
            await api.post(`/v1/admin/users/${u.id}/${deactivate ? 'deactivate' : 'reactivate'}`);
            setEditing(null);
            await reload();
          } catch (e) {
            Alert.alert(t('error'), (e as ApiError).code);
          }
        },
      },
    ]);
  };

  return (
    <Screen scroll>
      <Title>{t('users')}</Title>
      {!locked ? <Button title={`＋ ${t('inviteUser')}`} onPress={() => setEditing({ role: 'user' })} /> : <Muted>{t('managedBy', { name: org?.org.name ?? '' })}</Muted>}
      <Section>
        {(data?.users ?? []).map((u, i) => (
          <React.Fragment key={u.id}>
            {i ? <Divider /> : null}
            <Row
              title={u.name || u.phone}
              subtitle={[u.jobTitle, u.role === 'admin' ? t('roleAdmin') : t('roleUser'), statusLabel(u.status), u.phone].filter(Boolean).join(' · ')}
              left={<Avatar name={u.name || '?'} size={36} />}
              onPress={locked ? undefined : () => setEditing(u)}
            />
          </React.Fragment>
        ))}
      </Section>
      <Modal visible={!!editing} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setEditing(null)}>
        <Screen scroll>
          <Title>{editing?.id ? editing.name : t('inviteUser')}</Title>
          {!editing?.id ? <Field label={t('phone')} keyboardType="phone-pad" value={editing?.phone ?? ''} onChangeText={(phone) => setEditing((e) => ({ ...e, phone }))} /> : null}
          <Field label={t('name')} value={editing?.name ?? ''} onChangeText={(name) => setEditing((e) => ({ ...e, name }))} />
          <Field label={t('jobTitle')} value={editing?.jobTitle ?? ''} onChangeText={(jobTitle) => setEditing((e) => ({ ...e, jobTitle }))} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label={t('roleUser')} active={editing?.role !== 'admin'} onPress={() => setEditing((e) => ({ ...e, role: 'user' }))} />
            <Chip label={t('roleAdmin')} active={editing?.role === 'admin'} onPress={() => setEditing((e) => ({ ...e, role: 'admin' }))} />
          </View>
          <ErrorText>{error}</ErrorText>
          <Button title={editing?.id ? t('save') : t('invite')} onPress={save} />
          {editing?.id ? <Button variant="danger" title={editing.status === 'deactivated' ? t('reactivate') : t('deactivate')} onPress={() => toggleActive(editing as AdminUser)} /> : null}
          <Button variant="ghost" title={t('cancel')} onPress={() => setEditing(null)} />
        </Screen>
      </Modal>
    </Screen>
  );
}
