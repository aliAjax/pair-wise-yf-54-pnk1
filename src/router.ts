import { createRouter, createWebHistory } from 'vue-router';
import CheckinView from './views/CheckinView.vue';
import ExposureView from './views/ExposureView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: CheckinView },
    { path: '/exposure', component: ExposureView }
  ]
});
