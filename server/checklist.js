const COMMON_GROUPS = {
  entrance: [
    'Doors, glass, handles, keypad and mats clean',
    'Screen and camera area clean; camera view clear',
    'Floor clean, dry and clear'
  ],
  corridors: [
    'Checked on all three floors',
    'Floors, corners, skirting and behind doors clean',
    'Handrails, switches and handles clean; no cobwebs',
    'Walkways and exits clear; lights working'
  ],
  bathrooms: [
    'All shared facilities and ensuite bathrooms checked',
    'Toilets clean, including rims, seats, hinges, bases and behind toilets',
    'Showers, grout, screens and corners free from hair, soap scum and mould',
    'Basins, taps, mirrors, shelves, handles and locks clean',
    'Drains clear; no leaks, blockages or bad smells',
    'Toilet paper and soap stocked where provided',
    'Bins emptied; floors and corners clean and dry'
  ],
  kitchen: [
    'Benches, sinks, taps, hotplates and splashbacks clean',
    'Microwaves, kettles and toaster crumb trays clean',
    'Fridge shelves, drawers, seals and handles clean',
    'Kitchenware clean and put away; food storage checked',
    'Tables, chairs and under furniture clean',
    'Bins emptied; floors clean; no food scraps, grease or pests'
  ],
  laundry: [
    'Machines, seals, detergent drawers and drums clean',
    'Dryer lint filters checked; no lint buildup or spills',
    'Clean and dirty linen separated; supplies tidy',
    'Leaks and faulty machines reported'
  ],
  courtyard: [
    'No litter, cigarette butts, leaves or food scraps',
    'Floors, corners, outdoor furniture and underneath clean',
    'Drains clear; no standing water or cobwebs',
    'Bin area tidy; no overflow, spills, smells or pests',
    'Paths and exits clear; damage and lighting issues reported'
  ],
  storage: [
    'Floors and shelves tidy; access clear',
    'Clean linen protected; dirty linen separate',
    'Chemicals labelled and closed; no leaks, rubbish or pests'
  ]
};

const ROOM_CHECKS = [
  'Every bed and upper bunk checked; ready beds have clean linen',
  'Mattresses and protectors checked during changeovers for stains, damage and bedbugs',
  'Bed frames, rails, ladders, lights and shelves clean and secure',
  'Under beds, luggage spaces, corners and behind doors clean',
  'Empty lockers, windowsills and visible aircon vents clean; guest belongings respected',
  'Rubbish bin emptied and clean; floors clean and dry',
  'No mould, leaks, pests or unusual smells; faults reported'
];

const BATHROOM_CHECKS = COMMON_GROUPS.bathrooms.slice(1);
const ENSUITE_ROOMS = new Set([1, 2, 3, 6, 15, 19, 20]);
const ARRANGEMENT_CHECK_ROOMS = new Set([15, 20]);

const FLOORS = ['Ground floor', 'First floor', 'Second floor'];

function facilityChecks(type) {
  return BATHROOM_CHECKS.filter((item) => !(type === 'toilet' && item.startsWith('Showers')))
    .filter((item) => !(type === 'shower' && item.startsWith('Toilets')));
}

function buildChecklist() {
  const groups = [];

  function addGroup({ id, name, subtitle = '', floor, kind, icon, items }) {
    groups.push({ id, name, subtitle, floor, kind, icon, items });
  }

  function addRoom(number, floor) {
    const ensuite = ENSUITE_ROOMS.has(number);
    const items = [
      ...ROOM_CHECKS,
      ...(number === 6 ? ['Both connected sleeping areas checked (4-person and 10-person sections)'] : []),
      ...(ensuite ? BATHROOM_CHECKS.map((item) => 'Ensuite: ' + item) : []),
      ...(ARRANGEMENT_CHECK_ROOMS.has(number)
        ? ['Bathroom arrangement confirmed on site; any difference from the property sheet recorded in handover']
        : [])
    ];

    addGroup({
      id: 'room-' + number,
      name: 'Room ' + number,
      subtitle: ensuite ? 'Ensuite bathroom' : 'Shared bathroom',
      floor,
      kind: 'room',
      icon: 'bed',
      items
    });
  }

  function addFacility(type, number, location, floor) {
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    addGroup({
      id: type + '-' + number,
      name: label + ' ' + number,
      subtitle: location,
      floor,
      kind: 'bath',
      icon: type === 'shower' ? 'shower' : 'droplet',
      items: facilityChecks(type)
    });
  }

  addGroup({
    id: 'entrance-ground',
    name: 'Entrance & virtual reception',
    subtitle: 'Arrivals, camera and front desk',
    floor: FLOORS[0],
    kind: 'common',
    icon: 'door',
    items: COMMON_GROUPS.entrance
  });

  addGroup({
    id: 'corridors-ground',
    name: 'Ground floor corridors & access',
    subtitle: 'Corridors, stairs and walkways',
    floor: FLOORS[0],
    kind: 'common',
    icon: 'stairs',
    items: COMMON_GROUPS.corridors.slice(1)
  });

  for (let n = 1; n <= 3; n++) addRoom(n, FLOORS[0]);
  addFacility('toilet', 1, 'Next to Room 2', FLOORS[0]);
  addFacility('toilet', 2, 'In front of Room 3', FLOORS[0]);

  addGroup({
    id: 'kitchen-ground',
    name: 'Kitchen & dining',
    subtitle: 'Shared kitchen and dining area',
    floor: FLOORS[0],
    kind: 'common',
    icon: 'utensils',
    items: COMMON_GROUPS.kitchen
  });
  addGroup({
    id: 'laundry-ground',
    name: 'Laundry',
    subtitle: 'Ground floor laundry',
    floor: FLOORS[0],
    kind: 'common',
    icon: 'washer',
    items: COMMON_GROUPS.laundry
  });
  addGroup({
    id: 'courtyard-ground',
    name: 'Courtyard & backyard',
    subtitle: 'Outdoor shared areas',
    floor: FLOORS[0],
    kind: 'common',
    icon: 'tree',
    items: COMMON_GROUPS.courtyard
  });
  addGroup({
    id: 'storage-ground',
    name: 'Storage & garage',
    subtitle: 'Supplies, chemicals and parking',
    floor: FLOORS[0],
    kind: 'common',
    icon: 'box',
    items: COMMON_GROUPS.storage
  });

  addGroup({
    id: 'corridors-first',
    name: '1st level corridors, stairs & outside walkways',
    subtitle: 'Corridors, stairs and walkways',
    floor: FLOORS[1],
    kind: 'common',
    icon: 'stairs',
    items: COMMON_GROUPS.corridors.slice(1)
  });

  for (let n = 4; n <= 16; n++) addRoom(n, FLOORS[1]);
  addFacility('toilet', 3, 'Next to Room 5', FLOORS[1]);
  addFacility('shower', 4, 'Next to Room 5', FLOORS[1]);
  addFacility('bathroom', 5, 'In front of Room 14', FLOORS[1]);
  addFacility('bathroom', 6, 'In front of Room 14', FLOORS[1]);
  addFacility('toilet', 7, 'In front of Room 14', FLOORS[1]);
  addFacility('bathroom', 8, 'In front of Room 9', FLOORS[1]);
  addFacility('toilet', 9, 'Next to Room 16', FLOORS[1]);

  addGroup({
    id: 'laundry-first',
    name: 'Laundry',
    subtitle: 'First floor laundry',
    floor: FLOORS[1],
    kind: 'common',
    icon: 'washer',
    items: COMMON_GROUPS.laundry
  });

  addGroup({
    id: 'corridors-second',
    name: '2nd level corridors, stairs & outside walkways',
    subtitle: 'Corridors, stairs and walkways',
    floor: FLOORS[2],
    kind: 'common',
    icon: 'stairs',
    items: COMMON_GROUPS.corridors.slice(1)
  });

  for (let n = 17; n <= 28; n++) addRoom(n, FLOORS[2]);
  addFacility('toilet', 11, 'Next to Room 18', FLOORS[2]);
  addFacility('shower', 12, 'Next to Room 19', FLOORS[2]);
  addFacility('bathroom', 13, 'In front of Room 27', FLOORS[2]);
  addFacility('bathroom', 14, 'In front of Room 27', FLOORS[2]);
  addFacility('toilet', 15, 'In front of Room 26', FLOORS[2]);
  addFacility('bathroom', 16, 'In front of Room 23', FLOORS[2]);
  addFacility('toilet', 17, 'Next to Room 20', FLOORS[2]);
  addFacility('shower', 18, 'Next to Room 28', FLOORS[2]);

  return groups;
}

function checklistStats(groups) {
  const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0);
  return { totalGroups: groups.length, totalItems };
}

module.exports = { buildChecklist, checklistStats, FLOORS };
