// Generated from exact AXTP/Runtime commits by scripts/sync-axtp-typed-input.mjs.
export const INPUT_CONTRACT = Object.freeze({
  "sourceCommit": "48144141775da6c35e579d2498d88c0b0449ed61",
  "runtimeCommit": "22a21721f6ccb7d48eb980c1a94ff309325e446f",
  "axentCommit": "21ba313b79cba13e9eb189860fed27a8493f35c4",
  "version": "0.18.0-dev.feac6fa2a4b9",
  "fingerprint": "feac6fa2a4b9c927708c077746166259ffeb7d5f06dc6972b29f1fc30954c2d0",
  "published": false,
  "corpusSha256": "f4ec706d34353b2532f84f3cd9a228145671d7c9345258293a9bff0b6d637645",
  "protocolSha256": "4779a95953da7b1834655e061bb1a2f02998473899711fc4d131ae87d96058a7"
});
export const INPUT_WIRE = {
  "format": "input-sample-v1",
  "byteOrder": "big-endian",
  "streamHeaderBytes": 16,
  "typeBytes": 1,
  "maxDataBytes": 4096,
  "inputTypes": {
    "touch": 1,
    "mouse": 2
  },
  "touch": {
    "recordBytes": 7,
    "maxContacts": 256,
    "sampling": "complete",
    "phases": {
      "down": 0,
      "move": 1,
      "up": 2,
      "cancel": 3
    },
    "fields": [
      {
        "name": "contactId",
        "offset": 0,
        "bytes": 2,
        "type": "uint16"
      },
      {
        "name": "phase",
        "offset": 2,
        "bytes": 1,
        "type": "uint8"
      },
      {
        "name": "x",
        "offset": 3,
        "bytes": 2,
        "type": "uint16"
      },
      {
        "name": "y",
        "offset": 5,
        "bytes": 2,
        "type": "uint16"
      }
    ]
  },
  "mouse": {
    "buttons": {
      "left": 1,
      "right": 2,
      "middle": 4,
      "back": 8,
      "forward": 16
    },
    "modifiers": {
      "shift": 1,
      "ctrl": 2,
      "alt": 4,
      "meta": 8
    },
    "wheelUnits": {
      "detent120": 0,
      "regionQ16_16": 1
    },
    "wheelPhases": {
      "none": 0,
      "began": 1,
      "changed": 2,
      "ended": 3,
      "cancelled": 4
    },
    "records": [
      {
        "name": "move",
        "kind": 0,
        "bytes": 11,
        "fields": [
          {
            "name": "eventKind",
            "offset": 0,
            "bytes": 1,
            "type": "uint8"
          },
          {
            "name": "modifiers",
            "offset": 1,
            "bytes": 2,
            "type": "uint16"
          },
          {
            "name": "buttons",
            "offset": 3,
            "bytes": 4,
            "type": "uint32"
          },
          {
            "name": "x",
            "offset": 7,
            "bytes": 2,
            "type": "uint16"
          },
          {
            "name": "y",
            "offset": 9,
            "bytes": 2,
            "type": "uint16"
          }
        ]
      },
      {
        "name": "buttons",
        "kind": 1,
        "bytes": 11,
        "fields": [
          {
            "name": "eventKind",
            "offset": 0,
            "bytes": 1,
            "type": "uint8"
          },
          {
            "name": "modifiers",
            "offset": 1,
            "bytes": 2,
            "type": "uint16"
          },
          {
            "name": "buttons",
            "offset": 3,
            "bytes": 4,
            "type": "uint32"
          },
          {
            "name": "x",
            "offset": 7,
            "bytes": 2,
            "type": "uint16"
          },
          {
            "name": "y",
            "offset": 9,
            "bytes": 2,
            "type": "uint16"
          }
        ]
      },
      {
        "name": "wheel",
        "kind": 2,
        "bytes": 21,
        "fields": [
          {
            "name": "eventKind",
            "offset": 0,
            "bytes": 1,
            "type": "uint8"
          },
          {
            "name": "modifiers",
            "offset": 1,
            "bytes": 2,
            "type": "uint16"
          },
          {
            "name": "buttons",
            "offset": 3,
            "bytes": 4,
            "type": "uint32"
          },
          {
            "name": "x",
            "offset": 7,
            "bytes": 2,
            "type": "uint16"
          },
          {
            "name": "y",
            "offset": 9,
            "bytes": 2,
            "type": "uint16"
          },
          {
            "name": "wheelUnit",
            "offset": 11,
            "bytes": 1,
            "type": "uint8"
          },
          {
            "name": "wheelPhase",
            "offset": 12,
            "bytes": 1,
            "type": "uint8"
          },
          {
            "name": "wheelX",
            "offset": 13,
            "bytes": 4,
            "type": "int32"
          },
          {
            "name": "wheelY",
            "offset": 17,
            "bytes": 4,
            "type": "int32"
          }
        ]
      },
      {
        "name": "cancel",
        "kind": 3,
        "bytes": 1,
        "fields": [
          {
            "name": "eventKind",
            "offset": 0,
            "bytes": 1,
            "type": "uint8"
          }
        ]
      },
      {
        "name": "modifiers",
        "kind": 4,
        "bytes": 3,
        "fields": [
          {
            "name": "eventKind",
            "offset": 0,
            "bytes": 1,
            "type": "uint8"
          },
          {
            "name": "modifiers",
            "offset": 1,
            "bytes": 2,
            "type": "uint16"
          }
        ]
      }
    ]
  }
};
