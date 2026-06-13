# S3000L Software Compliance Guidelines

This document establishes the technical requirements, data models, XML schema rules, and database relationships necessary to implement a software application compliant with the **S3000L International Procedure Specification for Logistics Support Analysis (LSA)**. it was extracted from [s3000l/s3000l-issue-20.pdf](./s3000l/s3000l-issue-20.pdf)

---

## 1. S3000L Data Architecture Overview

The S3000L data architecture is specified as a coherent Unified Modeling Language (UML) class model. It is designed to run on a relational database or object-relational mapping (ORM) layer.

*   **UML & Common Data Model Alignment**: The S3000L data model is harmonized with the **SX002D Common Data Model (CDM) Issue 2.1**.
*   **Units of Functionality (UoF)**: The model is divided into 41 distinct UoFs. A UoF is a logical grouping of classes, relationships, and attributes designed to handle a specific domain within Logistics Support Analysis.
*   **Implementation Rule**: Classes are defined using `PascalCase` syntax. Attributes are defined using `camelCase` syntax. 

---

## 2. Core Database Schema & Entities

The following sections define the structural database classes, attributes, and relationships.

### 2.1 Product and Project Definition (UoF Product and Project)
Establishes the boundary of the LSA project, governing contract items, products, and product variants.

```
       [ Project ]
            |
            | (has)
            v
     [ ProjectContract ]
            |
            | (definedBy)
            v
       [ Contract ] <====== [ ContractParty ] =====> [ Organization ]
            |
            | (include)
            v
   [ ContractItemDetails ]
            |
            | (definedBy)
            v
     [ ProductVariant ] <====== (redefinedBy) ===== [ Product ]
```

#### Class: `Product`
Represents a family of items sharing a common design purpose (e.g., an aircraft, land vehicle, subsystem).
*   **Attributes**:
    *   `productIdentifier`: `IdentifierType` (Key, One or Many)
    *   `productName`: `NameType` (Zero, One or Many)
*   **Associations**:
    *   Aggregate association with one or many `ProductVariant` instances.

#### Class: `ProductVariant`
A specific model/configuration of a `Product` offered to a customer.
*   **Attributes**:
    *   `productVariantIdentifier`: `IdentifierType` (Key, One or Many)
    *   `productVariantName`: `NameType` (Zero, One or Many)

#### Class: `Project`
The overall set of LSA and Integrated Product Support (IPS) activities.
*   **Attributes**:
    *   `projectIdentifier`: `IdentifierType` (Key, One or Many)
    *   `projectName`: `NameType` (Zero, One or Many)

#### Class: `Contract`
*   **Attributes**:
    *   `contractIdentifier`: `IdentifierType` (Key, One or Many)
    *   `contractName`: `NameType` (Zero, One or Many)

---

### 2.2 Product Structure and Characteristics (UoF Breakdown Structure)
Determines how products are partitioned and mapped to physical parts.

```
      [ Breakdown ]
           |
           | (has)
           v
   [ BreakdownRevision ] <================== (has) ================== [ BreakdownElementUsageInBreakdown ]
           |                                                                           |
           | (has)                                                                     | (hasChild)
           v                                                                           v
 [ BreakdownElementRevision ] <--- (definedBy) --- [ BreakdownElement ]     [ BreakdownElementStructure ]
           ^
           | (realizedBy)
           v
 [ HardwareElementPartRealization ] 
           |
           | (definedBy)
           v
    [ PartAsDesigned ]
```

#### Class: `Breakdown`
Identifies a specific partitioning philosophy (e.g., Physical, Functional, Zonal, Hybrid).
*   **Attributes**:
    *   `breakdownType`: `ClassificationType` (Mandatory)

#### Class: `BreakdownElement`
An individual node in the hierarchical breakdown tree.
*   **Attributes**:
    *   `breakdownElementIdentifier`: `IdentifierType` (Key, One or Many)
    *   `breakdownElementName`: `NameType` (Zero, One or Many)
    *   `breakdownElementEssentiality`: `ClassificationType` (Zero or One)

#### Class: `BreakdownElementRevision`
Manages configuration changes and design iterations of a breakdown element.
*   **Attributes**:
    *   `breakdownElementRevisionIdentifier`: `IdentifierType` (Key, One)
    *   `breakdownElementDescription`: `DescriptorType` (Zero, One or Many)
    *   `maintenanceSignificantOrRelevant`: `ClassificationType` (Mandatory)

#### Relationship: `BreakdownElementStructure`
Establishes the explicit hierarchical parent-child relationship between two usages of `BreakdownElement` within the same `BreakdownRevision`.
*   **Attributes**:
    *   `breakdownElementChildSequenceNumber`: `umlString` (Zero or One)

#### Class: `BreakdownElementUsageInBreakdown`
Represents the structural usage of an element within a specific breakdown revision, separating the element definition from its specific context in a parent structure.
*   **Attributes**:
    *   `breakdownElementUsageIdentifier`: `IdentifierType` (Key, One or Many)
    *   `breakdownElementUsageQuantity`: `PropertyType` (Zero, One or Many)
    *   `referenceDesignator`: `IdentifierType` (Zero, One or Many)

---

### 2.3 Part Definition (UoF Part Definition)
Manages the hardware parts, software parts, and engineering/service bills of materials (BOM).

```
   [ PartAsDesigned ] <====== (has) ======> [ PartAsDesignedPartsList ]
          ^                                              |
          | (specializes)                                | (has)
          |                                              v
  +-------+-------------------------+      [ PartAsDesignedPartsListRevision ]
  |                                 |                    |
[ HardwarePartAsDesigned ]  [ SoftwarePartAsDesigned ]   | (has)
                                                         v
                                           [ PartAsDesignedPartsListEntry ]
                                                         |
                                                         | (usedPart)
                                                         v
                                                  [ PartAsDesigned ]
```

#### Class: `PartAsDesigned`
The definition of an artifact that can be produced, procured, or realized.
*   **Attributes**:
    *   `partIdentifier`: `IdentifierType` (Key, One or Many)
    *   `partName`: `NameType` (One or Many)

#### Class: `PartAsDesignedPartsList`
Typically referred to as a Bill of Material (BOM) representing assemblies.
*   **Attributes**:
    *   `partsListType`: `ClassificationType` (Mandatory) (e.g., `EBOM` [Engineering], `SBOM` [Service])

#### Class: `PartAsDesignedPartsListEntry`
An individual component line item within a specific parts list revision.
*   **Attributes**:
    *   `partsListEntryIdentifier`: `IdentifierType` (Key, One)
    *   `partsListEntryQuantity`: `PropertyType` (Zero or One)
    *   `physicalReplaceability`: `ClassificationType` (Zero or One)

---

### 2.4 LSA Candidate Selection (UoF LSA Candidate)
Governs LSA candidate item tracking and is used to document the analysis selection decisions.

#### Interface: `AnalysisCandidateItem`
Implemented by classes that can undergo formal LSA analysis (e.g., `BreakdownElement`, `BreakdownElementRevision`, `PartAsDesigned`).

#### Class: `AnalysisActivity`
Represents the objective and overall scope of an analysis task for a specific LSA candidate.
*   **Attributes**:
    *   `analysisActivityType`: `ClassificationType` (Mandatory)

#### Class: `AnalysisActivityRevision`
Represents a specific iteration of the analysis execution.
*   **Attributes**:
    *   `analysisActivityRevisionIdentifier`: `IdentifierType` (Key, One)
    *   `analysisActivityDecision`: `ClassificationType` (Mandatory)
    *   `analysisActivityRevisionStatus`: `StateType` (Mandatory)

#### Class: `AnalysisCandidateItemSelectionData`
Contains the decision attributes confirming whether a candidate is analyzed or not.
*   **Attributes**:
    *   `analysisCandidateItemSelectionIndicator`: `ClassificationType` (Mandatory)
    *   `analysisCandidateItemSelectionRationale`: `DescriptorType` (Zero, One or Many)

---

### 2.5 Task Requirements & Maintenance Task Analysis (UoFs Task & Task Requirement)
Handles the mapping between task requirements (triggers) and the actual step-by-step procedures (tasks) designed to satisfy them.

```
       [ TaskRequirement ]
                |
                | (has)
                v
   [ TaskRequirementRevision ] <===== (justifiedBy) ===== [ TaskRequirementJustification ]
                ^                                                       | (definedBy)
                |                                                       v
                | (justifiedBy / defines need)          [ TaskRequirementJustificationItem ]
                |                                                 (e.g., FailureMode)
                |
         [ TaskJustification ]
                |
                | (defines relation)
                v
          [ TaskRevision ] <===== (has) ===== [ Subtask ]
                ^                                 |
                | (has)                           +---> [ SubtaskByDefinition ]
                |                                 |
             [ Task ]                             +---> [ SubtaskByTaskReference ] =====> [ Task ]
```

#### Class: `TaskRequirement`
Represents an identified, validated requirement to perform a procedure to support a product (e.g., scheduled check, repair action).
*   **Attributes**:
    *   `taskRequirementIdentifier`: `IdentifierType` (Key, One or Many)

#### Class: `TaskRequirementRevision`
*   **Attributes**:
    *   `taskRequirementRevisionIdentifier`: `IdentifierType` (Key, One)
    *   `taskRequirementDescription`: `DescriptorType` (Mandatory)
    *   `taskRequirementInformationCode`: `ClassificationType` (Zero or One)

#### Class: `Task`
A detailed maintenance procedure or operational support procedure.
*   **Attributes**:
    *   `taskIdentifier`: `IdentifierType` (Key, One or Many)

#### Class: `TaskRevision`
An individual iteration/revision of a task definition.
*   **Attributes**:
    *   `taskRevisionIdentifier`: `IdentifierType` (Key, One)
    *   `taskName`: `NameType` (One or Many)
    *   `taskInformationCode`: `ClassificationType` (Mandatory)
    *   `taskDuration`: `PropertyType` (Zero, One or Many)
    *   `taskTotalLaborTime`: `PropertyType` (Zero, One or Many)

#### Class: `Subtask`
A discrete work step within a task procedure.
*   **Attributes**:
    *   `subtaskIdentifier`: `IdentifierType` (Key, One)
    *   `subtaskRole`: `ClassificationType` (Zero or One)

#### Class: `SubtaskByDefinition`
A subtask whose full procedural details are inline-defined inside the parent task.
*   **Attributes**:
    *   `subtaskName`: `NameType` (One or Many)
    *   `subtaskDescription`: `DescriptorType` (Zero, One or Many)
    *   `subtaskDuration`: `PropertyType` (Zero, One or Many)

#### Class: `SubtaskByTaskReference`
A subtask that references a separate, standalone reusable `Task` (e.g., "Gain access by removing door").
*   **Associations**:
    *   `referencedTask`: Points to exactly one `Task` instance.

---

### 2.6 Task Resources (UoF Task Resource)
Identifies the resources needed to execute tasks.

```
       [ TaskRevision ]
              |
              | (has)
              v
       [ TaskResource ] <========= (specialized by)
              |
     +--------+------------------+-------------------------+
     |                           |                         |
[ TaskMaterialResource ]  [ TaskPersonnelResource ]  [ TaskInfrastructureResource ]
     |                           |                         |
     | (realizedBy)              | (requires)              | (realizedBy)
     v                           v                         v
[ PartAsDesigned ]       [ TaskPersonnelResource   [ ResourceSpecification ]
                          Competence ]
                                 |
                                 | (definedBy)
                                 v
                     [ CompetencyDefinitionItem ]
```

#### Class: `TaskResource`
*   **Attributes**:
    *   `taskResourceIdentifier`: `IdentifierType` (Key, One or Many)
    *   `taskResourceFixedResourceMarker`: `umlBoolean` (Mandatory)
    *   `taskResourceDuration`: `PropertyType` (Zero, One or Many)

#### Class: `TaskMaterialResource`
Used to assign physical parts or support equipment as a task resource.
*   **Attributes**:
    *   `taskMaterialResourceQuantity`: `PropertyType` (One or Many)
    *   `taskMaterialResourceCategory`: `ClassificationType` (Zero, One or Many)

#### Class: `TaskPersonnelResource`
Used to assign human resources.
*   **Attributes**:
    *   `taskPersonnelResourceRole`: `ClassificationType` (Mandatory)
    *   `taskPersonnelResourceQuantity`: `PropertyType` (Zero, One or Many)
    *   `taskPersonnelResourceLaborTime`: `PropertyType` (Zero, One or Many)

---

## 3. Relational Rules & Integrity Constraints

An application must implement the following business logic, structural constraints, and database relationships:

### 3.1 Implicit vs. Explicit Breakdowns
1.  **Explicit Relationship**: When using modern PDM/PLM architectures, parent-child relationships must be managed via explicit relational database entries (`BreakdownElementStructure` connecting `BreakdownElementUsageInBreakdown` entries).
2.  **Implicit Relationship**: When migrating legacy systems (e.g., MIL-STD-1388-2B, GEIA-STD-0007, or S1000D), hierarchy may be implied via string syntax in identifiers.
    *   *S1000D SNS Mapping*: Standard Numbering System codes represent implicit parent-child relationships.
    *   *GEIA-STD-0007 LCN Mapping*: Logistics Control Numbers represent implicit parent-child relationships.
    *   *LCN/ALC Migration*: If migrating legacy LCN and ALC (Alternate LCN Code) data, they must be concatenated into a single unique `breakdownElementIdentifier` string (e.g., `[EIAC]-[LCN]-[ALC]`) to maintain relational integrity in S3000L.

### 3.2 Hardware-Part Decoupling
*   A `HardwareElement` represents an abstract engineering placement holder or functional slot inside the breakdown tree.
*   A `PartAsDesigned` is the physical manufacturing/procurement definition.
*   `HardwareElementPartRealization` acts as the mapping class between them. Software engines must support **Many-to-Many mappings** to allow:
    1.  Multiple alternate parts to be eligible to occupy a single hardware breakdown element location.
    2.  A single part number to be used in multiple physical locations across the breakdown tree.

### 3.3 Task Justification and Validation
*   **Strict Relational Rule**: Each instance of `RectifyingTask` must be justified by at least one `TaskRequirement` via a `TaskJustification` record. Loose, orphan rectifying tasks without a validating requirement are structurally invalid.

### 3.4 Software and Hardware Structural Coherence
*   Software elements are defined using the `SoftwareElement` and `SoftwarePartAsDesigned` classes.
*   Software modifications do **not** constitute a repair action or "preventive maintenance". Changes to source code must be treated as design modifications managed via a `ChangeAuthorization` and a new `SoftwareElementRevision` or `PartAsDesignedPartsListRevision`.

---

## 4. XML Schema and Data Exchange Integrity

Data exchanges under S3000L must comply with the official W3C XML schemas published at `www.s3000l.org`.

### 4.1 Schema Mappings and Wrapper Elements
To facilitate bulk and delta data exchanges, S3000L uses XML wrapper elements that contain collections of core business objects. The exchange engine must use these exact root wrappers:

| XML Wrapper Element | Contained UML Class |
| :--- | :--- |
| `<AllowedProductConfigurationsByConfigurationIdentifier>` | `AllowedProductConfigurationByConfigurationIdentifier` |
| `<ApplicabilityDefinitionData>` | `ApplicabilityStatement` |
| `<BreakdownElements>` | `BreakdownElement` |
| `<ChangeAuthorizations>` | `ChangeAuthorization` |
| `<ChangeRequests>` | `ChangeRequest` |
| `<CircuitBreakers>` | `CircuitBreaker` |
| `<CompetencyDefinitions>` | `CompetencyDefinitionItem` (Skill, Trade, etc.) |
| `<ConditionTypes>` | `ConditionType` |
| `<Contracts>` | `Contract` |
| `<Countries>` | `Country` |
| `<DecisionTreeTemplates>` | `DecisionTreeTemplate` |
| `<DigitalFiles>` | `DigitalFile` |
| `<Documents>` | `Document` |
| `<EnvironmentDefinitions>` | `EnvironmentDefinition` |
| `<Facilities>` | `Facility` |
| `<GeographicalAreas>` | `GeographicalArea` |
| `<GlobalPositions>` | `GlobalPosition` |
| `<MaintenanceLevels>` | `MaintenanceLevel` |
| `<OperatingLocationTypes>` | `OperatingLocationType` |
| `<Organizations>` | `Organization` |
| `<Parts>` | `PartAsDesigned` |
| `<Products>` | `Product` |
| `<Projects>` | `Project` |
| `<ResourceSpecifications>` | `ResourceSpecification` |
| `<TaskRequirements>` | `TaskRequirement` |
| `<Tasks>` | `Task` |

### 4.2 Exchange Message Types
1.  **Baseline Exchange**: Full dataset containing complete tables and structural relationships.
2.  **Net-Change / Update Exchange**: Only transmits delta data since the last synchronization timestamp. The importing database must resolve updates and merge incoming XML elements using their unique business identifiers (`breakdownElementIdentifier`, `partIdentifier`, `taskIdentifier`, etc.).

---

## 5. Valid Value Libraries and Validation Rules

An LSA-compliant database engine must enforce the following enumerations and validation rules.

### 5.1 `aggregatedElementType` (Enum)
Defines the functional classification of an aggregate breakdown element:
*   `FA` — `familyBreakdownElement`: Used to represent collections of minor parts (e.g., standard wire types, pipes, clamps).
*   `FU` — `functionBreakdownElement`: Partitions the product functionally.
*   `GR` — `groupBreakdownElement`: Groups arbitrary items.
*   `SY` — `systemBreakdownElement`: Partitions the product into engineering systems/subsystems.

### 5.2 `analysisActivityDecision` (Enum)
Defines the status of an analysis recommendation:
*   `O` — `toBeDecidedAnalysisActivity`
*   `R` — `rejectedAnalysisActivity`
*   `S` — `selectedAnalysisActivity`

### 5.3 `analysisActivityType` (Enum)
Categorizes the active analytical process running against LSA candidates:
*   `CMP` — `lsaComparativeAnalysis`
*   `COR` — `lsaCorrectiveMaintenanceAnalysis`
*   `DMG` — `lsaDamageAnalysis`
*   `HF` — `lsaHumanFactorAnalysis`
*   `LORA` — `lsaLevelOfRepairAnalysis`
*   `MNT` — `lsaMaintainabilityAnalysis`
*   `MTA` — `lsaMaintenanceTaskAnalysis`
*   `OP` — `lsaOperationalAnalysis`
*   `REL` — `lsaReliabilityAnalysis`
*   `SEV` — `lsaSpecialEventAnalysis`
*   `SIM` — `lsaSimulationOperationalScenariosAnalysis`
*   `SWD` — `lsaSoftwareDataLoadingAnalysis`
*   `SWS` — `lsaSoftwareSupportAnalysis`
*   `TNA` — `lsaTrainingNeedsAnalysis`
*   `TST` — `lsaTestabilityAnalysis`

### 5.4 `breakdownElementEssentiality` (Enum)
*   `1` — `criticalBreakdownElement`
*   `2` — `partialCriticalBreakdownElement`
*   `3` — `nonCriticalBreakdownElement`

### 5.5 `breakdownType` (Enum)
*   `ASD` — `asdSystemHardwareBreakdown`
*   `FAM` — `familyBreakdown`
*   `FU` — `functionalBreakdown`
*   `PH` — `physicalBreakdown`
*   `PR` — `provisioningBreakdown`
*   `SY` — `systemBreakdown`
*   `ZONE` — `zonalBreakdown`

### 5.6 `changeRequestStatus` (Enum)
*   `A` — `approvedChangeRequest`
*   `IW` — `inWorkChangeRequest`
*   `R` — `rejectedChangeRequest`
*   `S` — `submittedChangeRequest`

### 5.7 `circuitBreakerState` (Enum)
*   `C` — `closeCircuitBreakerState`
*   `O` — `openCircuitBreakerState`
*   `VC` — `verifyCloseCircuitBreakerState`
*   `VO` — `verifyOpenCircuitBreakerState`

### 5.8 `circuitBreakerType` (Enum)
*   `CLIP` — `dummyCircuitBreaker`
*   `ELMEC` — `electroMechanicCircuitBreaker`
*   `ELTRO` — `electronicCircuitBreaker`

### 5.9 `taskOperabilityImpact` (Enum)
Indicates the state of the parent asset while the task is performed:
*   `A` — `systemInoperableDuringTaskExecution` (Asset is offline)
*   `B` — `systemOperableDuringTaskExecution` (Asset remains fully online)
*   `C` — `systemFullMissionCapableDuringTaskExecution`
*   `D` — `systemPartialMissionCapableDuringTaskExecution`
*   `E` — `productNotMissionCapableDuringTaskExecution`
*   `G` — `turnaroundTask`

### 5.10 `taskPersonnelResourceRole` (Enum)
*   `A` — `assistantTaskPersonnelResource`
*   `P` — `performerTaskPersonnelResource`
*   `Q` — `qualityAssuranceTaskPersonnelResource`
*   `S` — `supervisorTaskPersonnelResource`

### 5.11 `warningCautionNoteType` (Enum)
*   `C` — `cautionAdvise`
*   `N` — `noteAdvise`
*   `W` — `warningAdvise`

---

## 6. Analytical & Business Logic Validation Rules

To prevent data corruption, S3000L compliance requires the application to enforce several functional validation rules:

### 6.1 Interval Adaptation Logic (Chapter 10)
When packaging Preventive Maintenance Task Requirements Intervals (`PMTRI`), the software must apply strict safety and regulatory checks before modifying interval values:

*   **Rule for Safety and Environmental Criticalities**:
    *   The database must enforce that any `PMTRI` protecting against a Functional Failure Effect (`FFE`) categorized as **Product Safety**, **Compliance with Law**, or **Environmental Integrity** **MUST NOT BE EXTENDED**.
    *   *Action*: If packaging calculations attempt to round up or extend a safety-critical interval, the system must trigger a validation block. It must only allow interval reduction (shortening the time limit).
*   **Rule for Economic and Operational Criticalities**:
    *   Intervals designed solely to protect against **operational/mission availability** or **economic impact** may be extended or reduced.
    *   *Action*: The software must prompt for explicit **User/Customer Agreement** confirmation before updating the database.

### 6.2 Task Duration vs. Labor Time (Chapter 12)
*   **Rule**: The software must mathematically separate `taskDuration` (Mean Elapsed Time, or MET) from `taskTotalLaborTime`.
*   **Validation Check**: Total labor time may exceed or be less than elapsed duration if multiple personnel work on parallel subtasks.
    *   *Example*: Three technicians working in parallel on a subtask taking 20 minutes must yield:
        *   `subtaskDuration` = 20 minutes
        *   `taskTotalLaborTime` = 60 minutes
*   **Timeline Calculations**: The database must utilize `SubtaskTimeline` records to map parallel/serial execution logic. It must validate that dependent successor subtasks do not have start times preceding the completion of their predecessor subtasks unless specifically allowed by `subtaskTimelineLag`.

### 6.3 Maintenance Level Strategy Validation (Chapter 11 & 12)
*   The system must enforce that the maintenance location and Level of Repair Analysis (`LORA`) output match.
*   **Validation check**: If an LSA candidate's `hardwareElementReplaceability` or `hardwareElementRepairability` is classified as `Level 1` (Operational), the system must raise a warning if any assigned task resource requires tools or facilities restricted to `Level 3` (Depot Level, e.g., `DOCK`, `DRYD`, or clean rooms).