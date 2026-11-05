import React from 'react';
import { router } from 'expo-router';
import { useI18n } from '../../src/i18n';
import { useSession } from '../../src/state/session';
import { Avatar, Badge, Button, Divider, Muted, Row, Screen, Section, Title } from '../../src/ui/kit';

/** Org picker (several orgs) / empty state (none). Also used as the org switcher. */
export default function Orgs() {
  const { t, locale, setLocale } = useI18n();
  const { orgs, selectOrg, logout, org } = useSession();
  return (
    <Screen scroll>
      <Title sub={orgs.length ? undefined : t('noOrgsHint')}>{orgs.length ? t('selectOrg') : t('noOrgsTitle')}</Title>
      {orgs.length ? (
        <Section>
          {orgs.map((o, i) => (
            <React.Fragment key={o.id}>
              {i ? <Divider /> : null}
              <Row
                title={o.name}
                subtitle={`${o.role === 'admin' ? t('roleAdmin') : t('roleUser')}${o.jobTitle ? ' · ' + o.jobTitle : ''}`}
                left={<Avatar name={o.name} size={40} />}
                right={<Badge n={o.unread ?? 0} />}
                onPress={async () => {
                  await selectOrg(o.id);
                  router.replace('/(main)/(tabs)');
                }}
              />
            </React.Fragment>
          ))}
        </Section>
      ) : null}
      <Button variant="secondary" title={t('createOrg')} onPress={() => router.push('/(auth)/create-org')} />
      {org ? <Button variant="ghost" title={t('close')} onPress={() => router.back()} /> : null}
      <Button variant="ghost" title={t('language')} onPress={() => setLocale(locale === 'he' ? 'en' : 'he')} />
      <Button variant="ghost" title={t('logout')} onPress={logout} />
      <Muted> </Muted>
    </Screen>
  );
}
