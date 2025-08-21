# server

## If you use bun
To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```
## To run without bun
```bash
node ./build/index.js
```

## Pathway
- Runs on port 3000


### /add-customer
Needs request body as
```json
{
    "customer": {
        "name": "Example",
            "number": "+91 9923523232", // try keeping all in the same format whatever the format is
            "email": "k@gmail.com" // Optional
    }
}
```
returns the customer_id if you want to store it somewhere

### /add-table
Needs request body as
```json
{
    "table": {
        "name": "T1",
            "capacity": 4 // Optional
    }
}
```
returns the table_name if you want to store it somewhere

### /add-booking
Needs request body as
```json
{
    // creates customer if the name+number does not exist
    "customer": {
        "name": "Jhon",
            "number": "9972955566",
            "email": "example@gmail.com" //optional
    },
        // Table must exist
        "booking": {
            "table_name": "T1",
            "date": "YYYY-MM-DDThh:mm:ssTZD"
                "duration": "30" // in minutes
                "number_of_people": "3"
                "source": "EasyDiner" //Optional
        }
    ```
}
returns the booking id

### /get-tables
Returns tables in a 2d array in ascending order of capacity.
```json
[
    [
        {
            "table_name": "T1",
            "capacity": 1
        },
        {
            "table_name": "T2",
            "capacity": 1
        },
    ],
    [
        {
            "table_name": "T6",
            "capacity": 3
        },
        {
            "table_name": "T7",
            "capacity": 3
        }
    ],
    [
        {
            "table_name": "T10",
            "capacity": 6
        }
    ]
]
```

### /get-tables

Gets all bookings that have not yet completed 
If needed can be modified to get bookings after a certain time very easily
Returns in this format
```json
[
    {
        "booking": {
            "booking_id": 1, //database stuff
            "customer_id": 1, //database stuff
            "table_name": "T3",
            "booking_date_time": "2025-08-21T23:30:34.036Z", //time of booking ISO string
            "duration_mins": 60,
            "number_of_people": 3,
            "source": null // source of the booking
        },
        "active": true/false //whether or not the booking is currently happening
    }
]
```

### /get-customers
    Returns all customer data
```json
    [
        {
            "customer_id": 1,
            "name": "Dodo",
            "booking_count": 5,
            "has_booking": true // Does the customer have an active booking
        }
    ]
```

### /get-withen-range
returns the count of bookings in a range
requests body must be like this
```json
{
    start: 1004038434 // anything that can be parsed by Date()
    end: 1004038434 // anything that can be parsed by Date()
}
```
Date.parse documentation
https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/parse
for the best results just send ms since epoch

returns the number of bookings in that range

## Todo
Implementing auth for each request
