console.log("Testing Date validation:");
console.log("new Date('last-week'):", new Date('last-week'));
console.log("new Date('last-week').getTime():", new Date('last-week').getTime());
console.log("Number.isNaN(new Date('last-week').getTime()):", Number.isNaN(new Date('last-week').getTime()));

const date = new Date('last-week');
if (Number.isNaN(date.getTime())) {
  console.log("Date is invalid, should return 400");
} else {
  try {
    console.log("Date is valid, trying toISOString()");
    const iso = date.toISOString();
    console.log("toISOString() result:", iso);
  } catch (err) {
    console.log("toISOString() threw error:", err);
  }
}