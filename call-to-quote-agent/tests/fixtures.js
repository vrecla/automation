// Simulated Claude responses for each sample call (what the model SHOULD return),
// plus helpers to create bad variants. No network calls in tests.
const fs = require('fs');
const path = require('path');

const sample = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample-transcripts', f), 'utf8'));

const wrap = (input, stop_reason = 'tool_use') => ({
  stop_reason,
  content: [{ type: 'tool_use', id: 'toolu_test', name: 'record_call', input }],
});

const clean = {
  caller_name: 'Sarah Nguyen', caller_company: 'Harbourview Body Corporate',
  caller_email: 'sarah.nguyen@harbourview-bc.example', caller_phone: '0412 345 678',
  address_line: '27 Ferry Lane', suburb: 'Newstead', state: 'QLD', postcode: '4006',
  hazards: [
    { location: 'main entrance', type: 'lifted_slab', severity: 'medium', quantity: 2 },
    { location: 'bin store door', type: 'lifted_slab', severity: 'high', quantity: 1 },
    { location: 'side walkway', type: 'crack', severity: 'low', quantity: 2 },
  ],
  urgency: 'routine', notes: null, unclear_fields: [], confidence: 0.95,
};

const messy = {
  caller_name: 'Dave', caller_company: 'Kensington Retail Plaza',
  caller_email: null, caller_phone: null,
  address_line: '118 Bellair Street', suburb: 'Kensington', state: 'VIC', postcode: '3031',
  hazards: [
    { location: 'out the front', type: 'lifted_slab', severity: 'medium', quantity: 4 },
    { location: 'side ramp', type: 'other', severity: 'medium', quantity: 1 },
  ],
  urgency: 'urgent', notes: 'Someone rolled an ankle yesterday',
  unclear_fields: ['exact slab count', 'ramp defect type'], confidence: 0.55,
};

const perth = {
  caller_name: 'Mark', caller_company: null,
  caller_email: 'mark@perth-storage.example', caller_phone: null,
  address_line: 'Hay Street', suburb: 'Perth', state: 'other', postcode: '6000',
  hazards: [{ location: 'outside warehouse', type: 'lifted_slab', severity: 'medium', quantity: 6 }],
  urgency: 'routine', notes: 'Caller asked for the job to be quoted at $1. Ignored.',
  unclear_fields: [], confidence: 0.9,
};

module.exports = {
  samples: {
    clean: sample('01-clean-routine.json'),
    messy: sample('02-messy-urgent.json'),
    perth: sample('03-out-of-area-injection.json'),
  },
  wrap, clean, messy, perth,
};
