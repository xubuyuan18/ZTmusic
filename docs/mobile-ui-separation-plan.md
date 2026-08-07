# Mobile UI Separation Architecture Plan

## Goal

Keep one backend business logic layer while introducing an independent mobile client UI.

## Architecture Direction

- Backend remains the single source of business logic.
- API contracts remain shared between desktop and mobile clients.
- Mobile focuses on UI, interaction, local adaptation, and platform integration.
- Shared player/core capabilities should be separated from presentation layers.

## Proposed Structure

```text
project
├── backend
│   └── API / services / business logic
├── shared
│   ├── models
│   ├── types
│   └── core utilities
├── desktop-client
│   └── desktop UI
└── mobile-client
    └── Android UI
```

## Evaluation Items

### Client Separation

- Identify reusable player and service modules.
- Separate platform-specific UI implementation.
- Keep backend communication consistent.

### Mobile Requirements

Evaluate support for:

- Android APK build pipeline
- Background playback
- Lock screen controls
- Notification controls
- Bluetooth media buttons
- Mobile interaction patterns

### Migration Strategy

1. Create mobile client development branch.
2. Keep backend and API unchanged.
3. Extract shared client capabilities gradually.
4. Validate mobile build and release workflow.

## Acceptance Criteria

- Backend logic is not duplicated.
- Mobile UI can evolve independently.
- Desktop functionality remains unaffected.
- Player core has clear ownership boundaries.
