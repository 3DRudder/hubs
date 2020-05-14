import { paths } from "../paths";
//import { Sdk3dRudder } from '3drudder-js';
const Sdk3dRudder = require("3drudder-js");

export class Controller3dRudderDevice {
  constructor(opts) {
    this.axisMap = [
      { name: "leftright"},
      { name: "forwardbackward"},
      { name: "updown"},
      { name: "rotation"}
    ];
    this.sdk = new Sdk3dRudder(opts);
    console.log('[3dRudder] init');
    this.sdk.init();
    this.sdk.on('init', function(init) {
        console.log('[3dRudder] init uid ' + init.uid);
    });
  }

  write(frame) {
    // loop on each controller    
    this.sdk.controllers.forEach(function (rudder,index) {
        // only if connected
        if (rudder.connected) {
            const ruddderPaths = paths.device.drudder;      
            // loop on each axis to update value
            this.axisMap.forEach(axis => {
              frame.setValueType(ruddderPaths(index).axis(axis.name), rudder.axis[axis.name]);       
            });
        }
    }, this);
    
  }
}
