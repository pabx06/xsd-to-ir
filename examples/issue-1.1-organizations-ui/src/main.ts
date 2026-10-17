import { bootstrapApplication } from '@angular/platform-browser';
import { provideOptimus } from '@openng/optimus-ui/config';
import { definePreset } from '@openng/optimus-ui-themes';
import Aura from '@openng/optimus-ui-themes/aura';
import { App } from './app/app';
import { ENTITY_CRUD } from './app/models';
import { OfflineOrganizationService } from './app/offline.service';

const theme = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{teal.50}',
      100: '{teal.100}',
      200: '{teal.200}',
      300: '{teal.300}',
      400: '{teal.400}',
      500: '{teal.500}',
      600: '{teal.600}',
      700: '{teal.700}',
      800: '{teal.800}',
      900: '{teal.900}',
      950: '{teal.950}',
    },
    colorScheme: {
      light: {
        primary: {
          color: '{primary.700}',
          contrastColor: '#ffffff',
          hoverColor: '{primary.800}',
          activeColor: '{primary.900}',
        },
      },
    },
  },
});
bootstrapApplication(App, {
  providers: [
    provideOptimus({ theme: { preset: theme, options: { darkModeSelector: false } } }),
    { provide: ENTITY_CRUD, useExisting: OfflineOrganizationService },
  ],
}).catch((error) => console.error(error));
