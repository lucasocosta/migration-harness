import { FeatureComponent, AuthGuard, CustomerResolver, UnrelatedComponent } from '@feature/feature';

export const featureRoutes = [
  { path: 'customers', children: [{ path: ':id', component: FeatureComponent, canActivate: [AuthGuard], resolve: { customer: CustomerResolver } }] },
  { path: 'other', component: UnrelatedComponent },
  { path: 'lazy', loadComponent: () => import('./missing') },
];
